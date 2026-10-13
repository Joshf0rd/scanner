/* =========================================================
   pdf.js – turns a document's pages into one PDF (jsPDF)

   Page sizes:
     a4 / letter – each scan is fitted onto the paper size, centred,
                   portrait or landscape to match the scan
     fit         – each PDF page is exactly the shape of the scan
   The finished JPEG of each page is embedded as-is (no re-compression).
   With "Make text searchable" on, each page's OCR text (js/ocr.js) is
   placed invisibly over the image, so the PDF can be searched and copied.
   ========================================================= */

const PdfExport = (() => {
  const PAGE_SIZES = [
    { value: 'a4', label: 'A4' },
    { value: 'letter', label: 'US Letter' },
    { value: 'fit', label: 'Fit to scan' }
  ];
  const PAPER_MM = { a4: [210, 297], letter: [215.9, 279.4] };

  /**
   * Build the PDF Blob. onProgress(i, total) is called per page.
   * `pages` (optional) – already-loaded pages, e.g. after OCR; `searchable` adds the text layer.
   */
  async function build(doc, pageSize, onProgress, { pages = null, searchable = false } = {}) {
    if (!window.jspdf || !window.jspdf.jsPDF) throw new Error('The PDF library did not load. Reopen the app and try again.');
    pages = pages || await DB.getPages(doc);
    if (!pages.length) throw new Error('This document has no pages yet.');

    let pdf = null;
    for (let i = 0; i < pages.length; i++) {
      if (onProgress) onProgress(i + 1, pages.length);
      const page = pages[i];
      const images = await DB.get('pageImages', page.id);
      if (!images || !images.processed) throw new Error(`Page ${i + 1} image is missing.`);
      const bytes = new Uint8Array(await images.processed.arrayBuffer());

      const landscape = page.width > page.height;
      let pw, ph;
      if (pageSize === 'fit') {
        // Long side 297 mm (A4 length), short side in proportion
        const ratio = Math.min(page.width, page.height) / Math.max(page.width, page.height);
        pw = landscape ? 297 : 297 * ratio;
        ph = landscape ? 297 * ratio : 297;
      } else {
        const [a, b] = PAPER_MM[pageSize] || PAPER_MM.a4;
        pw = landscape ? b : a;
        ph = landscape ? a : b;
      }
      const orientation = landscape ? 'landscape' : 'portrait';
      if (!pdf) pdf = new window.jspdf.jsPDF({ unit: 'mm', format: [pw, ph], orientation, compress: true });
      else pdf.addPage([pw, ph], orientation);

      // Fit the image inside the page, keeping its shape
      const s = Math.min(pw / page.width, ph / page.height);
      const w = page.width * s, h = page.height * s;
      pdf.addImage(bytes, 'JPEG', (pw - w) / 2, (ph - h) / 2, w, h, 'p' + i, 'NONE');
      if (searchable && Ocr.hasText(page)) Ocr.addTextLayer(pdf, page.ocr, (pw - w) / 2, (ph - h) / 2, s);
      await Utils.nextFrame();   // keep the screen responsive
    }
    pdf.setProperties({ title: doc.name, creator: 'Scanner' });
    return pdf.output('blob');
  }

  /**
   * Ask for the file name + page size, build the PDF and offer Share / Download.
   * Saves a changed name back to the document. Resolves the (possibly renamed) doc.
   */
  async function exportDoc(doc) {
    let size = Settings.get().pageSize;
    const pagesNow = await DB.getPages(doc);
    const unread = pagesNow.filter(p => !Ocr.hasText(p)).length;
    const result = await Utils.modal({
      title: 'Save as PDF',
      bodyHtml: `
        <div class="field"><label for="pdf-name">File name</label>
          <div class="input-suffix"><input type="text" id="pdf-name" value="${Utils.esc(doc.name)}" autocomplete="off" enterkeyhint="done"><span>.pdf</span></div></div>
        <div class="field"><span class="label">Page size</span>
          <div class="segmented" id="pdf-size">${PAGE_SIZES.map(o =>
            `<button type="button" data-value="${o.value}" class="${o.value === size ? 'active' : ''}">${Utils.esc(o.label)}</button>`).join('')}</div></div>
        <div class="field">
          <label class="switch-row"><span>Make text searchable</span>
            <input type="checkbox" id="pdf-ocr" ${Settings.get().ocr ? 'checked' : ''}></label>
          <div class="hint">${unread
            ? `Reads the text on ${unread === pagesNow.length ? 'each page' : `${unread} new or changed page${unread === 1 ? '' : 's'}`} (a few seconds per page) so you can search and copy it in the PDF.`
            : 'Text already read – this is quick.'}</div>
        </div>`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: 'Create PDF', value: 'ok', className: 'primary' }
      ],
      onOpen: el => {
        const seg = el.querySelector('#pdf-size');
        seg.addEventListener('click', e => {
          const b = e.target.closest('button');
          if (!b) return;
          size = b.dataset.value;
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        });
      },
      getValue: el => {
        const input = el.querySelector('#pdf-name');
        const name = input.value.trim().replace(/\.pdf$/i, '');
        if (!name) {
          input.closest('.field').classList.add('invalid');
          input.focus();
          return undefined;
        }
        return { name, size, ocr: el.querySelector('#pdf-ocr').checked };
      }
    });
    if (!result) return doc;
    if (result.ocr !== Settings.get().ocr) await Settings.save({ ocr: result.ocr });

    if (result.name !== doc.name) {
      doc = { ...doc, name: result.name, modifiedAt: Utils.nowStamp() };
      await DB.put('docs', doc);
    }

    let blob;
    Utils.showLoading('Creating PDF…');
    try {
      await Utils.nextFrame();
      let pages = await DB.getPages(doc);
      if (result.ocr && pages.some(p => !Ocr.hasText(p))) {
        Utils.updateLoading('Starting text reader…');
        try {
          pages = await Ocr.ensure(pages, (i, n, f) =>
            Utils.updateLoading(`Reading text… page ${i} of ${n}${f ? ` (${Math.round(f * 100)}%)` : ''}`));
        } finally {
          Ocr.release();
        }
      }
      blob = await build(doc, result.size, (i, n) => Utils.updateLoading(`Creating PDF… page ${i} of ${n}`),
        { pages, searchable: result.ocr });
    } catch (err) {
      Ocr.release();
      Utils.hideLoading();
      console.error(err);
      await Utils.alert('PDF failed', err.message || String(err));
      return doc;
    }
    Utils.hideLoading();

    await Utils.offerFile(blob, Utils.safeFileName(doc.name) + '.pdf', {
      title: 'PDF ready',
      message: 'On iPhone: Share / Save → Save to Files to keep it, or pick Mail, Messages, etc.'
    });
    return doc;
  }

  return { PAGE_SIZES, build, exportDoc };
})();
