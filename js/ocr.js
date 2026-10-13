/* =========================================================
   ocr.js – reads the text on pages (Tesseract.js 5.1.1, English)

   Used when saving a PDF: each page's words and their positions are
   stored on the page record (page.ocr) and become an invisible text
   layer in the PDF, so the PDF can be searched and text selected/copied.
   A page's stored text is cleared whenever the page image changes
   (crop, rotate, look), so it is read again next time.

   All files live in js/lib/ocr (works offline):
     tesseract.min.js, worker.min.js        – the library
     tesseract-core-simd-lstm.wasm.js       – OCR engine (iOS 16.4+ / modern browsers)
     tesseract-core-lstm.wasm.js            – engine for older devices without SIMD
     eng.traineddata.gz                     – English language data

   page.ocr = { v, w, h, text, lines: [{ b: [x0,y0,x1,y1], bl: [x0,y0,x1,y1] | null,
                                          words: [[text, x0, y0, x1, y1], …] }] }
   (pixel coordinates of the finished page image, w × h)
   ========================================================= */

const Ocr = (() => {
  const VERSION = 1;              // bump to force pages to be re-read after an OCR change
  const MIN_CONFIDENCE = 35;      // skip words Tesseract is very unsure about (usually specks)
  let workerPromise = null;
  let progressCb = null;

  function libUrl(file) { return new URL('js/lib/ocr/' + file, location.href).href; }

  function getWorker() {
    if (workerPromise) return workerPromise;
    if (!window.Tesseract) return Promise.reject(new Error('The text reader did not load. Reopen the app and try again.'));
    workerPromise = Tesseract.createWorker('eng', 1, {
      workerPath: libUrl('worker.min.js'),
      corePath: libUrl(''),          // a folder: the best engine file for this phone is picked
      langPath: libUrl('').replace(/\/$/, ''),
      workerBlobURL: false,          // a normal worker file, so the offline cache serves it
      cacheMethod: 'none',           // the service worker already caches the language file
      logger: m => { if (progressCb && m.status === 'recognizing text') progressCb(m.progress); }
    }).catch(err => {
      workerPromise = null;
      throw err;
    });
    return workerPromise;
  }

  /** Free the engine's memory (call after a batch). */
  async function release() {
    if (!workerPromise) return;
    const p = workerPromise;
    workerPromise = null;
    try { (await p).terminate(); } catch (e) { /* already gone */ }
  }

  function hasText(page) { return !!(page.ocr && page.ocr.v === VERSION); }

  /** Read one finished page image. Returns the page.ocr object. */
  async function recognize(blob, width, height, onProgress) {
    const worker = await getWorker();
    progressCb = onProgress || null;
    try {
      const { data } = await worker.recognize(blob);
      const lines = [];
      for (const line of data.lines || []) {
        const words = (line.words || [])
          .filter(w => w.text && w.text.trim() && w.confidence >= MIN_CONFIDENCE)
          .map(w => [w.text.trim(), w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1]);
        if (!words.length) continue;
        const bl = line.baseline && line.baseline.has_baseline !== false
          ? [line.baseline.x0, line.baseline.y0, line.baseline.x1, line.baseline.y1] : null;
        lines.push({ b: [line.bbox.x0, line.bbox.y0, line.bbox.x1, line.bbox.y1], bl, words });
      }
      const text = lines.map(l => l.words.map(w => w[0]).join(' ')).join('\n');
      return { v: VERSION, w: width, h: height, text, lines };
    } finally {
      progressCb = null;
    }
  }

  /**
   * Make sure every page has text. Pages already read are skipped.
   * onProgress(pageNumber, total, fraction) for the loading message.
   * Saves results to the database as it goes. Returns the updated pages.
   */
  async function ensure(pages, onProgress) {
    const todo = pages.filter(p => !hasText(p));
    const out = pages.slice();
    let n = 0;
    for (const page of todo) {
      n++;
      if (onProgress) onProgress(n, todo.length, 0);
      const images = await DB.get('pageImages', page.id);
      if (!images || !images.processed) continue;
      const ocr = await recognize(images.processed, page.width, page.height,
        f => onProgress && onProgress(n, todo.length, f));
      // Re-read the record so a change made meanwhile isn't overwritten
      const fresh = await DB.get('pages', page.id);
      if (!fresh) continue;
      const updated = { ...fresh, ocr };
      await DB.put('pages', updated);
      out[out.findIndex(p => p.id === page.id)] = updated;
    }
    return out;
  }

  /**
   * Add a page's words to the current jsPDF page as invisible text.
   * The image was drawn at (ox, oy) mm with `scale` mm per image pixel.
   */
  function addTextLayer(pdf, ocr, ox, oy, scale) {
    if (!ocr || !ocr.lines) return;
    pdf.setFont('helvetica', 'normal');
    const PT_PER_MM = 72 / 25.4;
    for (const line of ocr.lines) {
      const lineH = (line.b[3] - line.b[1]) * scale;          // mm
      const fontSize = Math.max(2, lineH * PT_PER_MM * 0.8);   // pt; line box ≈ 1.25 × font size
      pdf.setFontSize(fontSize);
      for (const [text, x0, y0, x1, y1] of line.words) {
        // Baseline: from Tesseract's line baseline where known, else the word's bottom
        let by = y1;
        if (line.bl) {
          const [bx0, by0, bx1, by1] = line.bl;
          const t = bx1 !== bx0 ? (x0 - bx0) / (bx1 - bx0) : 0;
          by = by0 + (by1 - by0) * t;
          if (by < y0 || by > y1 + (y1 - y0)) by = y1;           // ignore odd baselines
        }
        const targetW = (x1 - x0) * scale;
        const naturalW = pdf.getTextWidth(text);
        const hs = naturalW > 0 ? Math.min(4, Math.max(0.25, targetW / naturalW)) : 1;
        pdf.text(text, ox + x0 * scale, oy + by * scale, {
          renderingMode: 'invisible', horizontalScale: hs, baseline: 'alphabetic'
        });
      }
    }
  }

  return { VERSION, hasText, recognize, ensure, release, addTextLayer };
})();
