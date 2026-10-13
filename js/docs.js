/* =========================================================
   docs.js – the screens
     Home      – list of saved scans
     Document  – page grid, rename, reorder, add pages, save PDF
     Page      – view one page; change look, rotate, re-crop, move, delete
   plus the scanning flow that adds new pages to a document.
   ========================================================= */

const Docs = (() => {
  const ICONS = {
    more: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    rotL: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6"/><path d="M2.66 15.57a10 10 0 1 0 .57-8.38L2.5 8"/></svg>',
    rotR: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6"/><path d="M21.34 15.57a10 10 0 1 1-.57-8.38L21.5 8"/></svg>',
    crop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/></svg>',
    photos: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    pdf: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M12 18v-6"/><path d="M9 15l3 3 3-3"/></svg>'
  };

  // =========================================================
  // Home – list of scans
  // =========================================================
  let searchText = '';

  async function renderList() {
    const docs = (await DB.getAll('docs')).sort((a, b) => (b.modifiedAt || '').localeCompare(a.modifiedAt || ''));
    App.render({
      title: 'Scanner',
      homeTitle: true,
      right: `<button type="button" class="icon-btn" id="btn-settings" aria-label="Settings">${App.ICONS.settings}</button>`,
      body: `
        ${docs.length > 3 ? `<input type="search" id="search" placeholder="Search scans" value="${Utils.esc(searchText)}" class="mb">` : ''}
        <div id="doc-list"></div>`,
      actions: `
        <button type="button" class="btn" id="btn-import">${ICONS.photos}Photos</button>
        <button type="button" class="btn primary grow2" id="btn-scan">${App.ICONS.camera}Scan</button>`
    });

    function draw() {
      const q = searchText.trim().toLowerCase();
      const list = q ? docs.filter(d => d.name.toLowerCase().includes(q)) : docs;
      const el = document.getElementById('doc-list');
      if (!docs.length) {
        el.innerHTML = `<div class="empty">
          <p><strong>No scans yet</strong></p>
          <p>Tap <b>Scan</b>, hold the phone over a page and take a photo of each page. They're combined into one PDF you can name and save.</p></div>`;
        return;
      }
      if (!list.length) { el.innerHTML = `<div class="empty">No scans match "${Utils.esc(searchText)}".</div>`; return; }
      el.innerHTML = list.map(d => `
        <a class="card doc-card" href="#/doc/${encodeURIComponent(d.id)}">
          ${d.thumb ? `<img class="doc-thumb" src="${d.thumb}" alt="">` : '<div class="doc-thumb none">Empty</div>'}
          <div class="doc-body">
            <div class="card-title">${Utils.esc(d.name)}</div>
            <div class="card-sub">${d.pageIds.length} page${d.pageIds.length === 1 ? '' : 's'} · ${Utils.esc(Utils.formatDateShort(d.modifiedAt))}</div>
          </div>
        </a>`).join('');
    }
    draw();

    const search = document.getElementById('search');
    if (search) search.addEventListener('input', () => { searchText = search.value; draw(); });
    document.getElementById('btn-settings').addEventListener('click', () => App.go('/settings'));
    document.getElementById('btn-scan').addEventListener('click', () => scan(null));
    document.getElementById('btn-import').addEventListener('click', () => importPhotos(null));
  }

  // =========================================================
  // Adding pages
  // =========================================================
  function newDoc() {
    const now = Utils.nowStamp();
    return { id: Utils.uid(), name: Utils.defaultScanName(), pageIds: [], thumb: null, createdAt: now, modifiedAt: now };
  }

  /**
   * Process one photo into a page and save it to `holder.doc`.
   * If "check corners" is on, the corner editor opens first.
   * Resolves { thumb } when saved, or null when the user chose Retake.
   */
  async function addPage(holder, { canvas, blob, corners }) {
    const s = Settings.get();
    if (s.reviewEachScan) {
      const res = await CropEditor.open({ canvas, corners });
      if (res === 'cancel') return null;
      corners = res.corners;
    }
    corners = corners || Imaging.fullFrameCorners(0);

    Utils.showLoading('Saving page…');
    try {
      await Utils.nextFrame();
      const page = {
        id: Utils.uid(), docId: holder.doc.id, corners, filter: s.filter, rotation: 0,
        createdAt: Utils.nowStamp()
      };
      const out = await Imaging.processPage(canvas, page);
      page.width = out.width;
      page.height = out.height;
      page.thumb = out.thumb;
      const doc = {
        ...holder.doc,
        pageIds: holder.doc.pageIds.concat(page.id),
        modifiedAt: Utils.nowStamp()
      };
      if (!doc.thumb || doc.pageIds.length === 1) doc.thumb = page.thumb;
      await DB.savePage({ doc, page, images: { id: page.id, docId: doc.id, original: blob, processed: out.blob } });
      holder.doc = doc;
      return { thumb: page.thumb };
    } finally {
      Utils.hideLoading();
    }
  }

  /** Open the camera and add pages to `doc` (or a new document when null). */
  async function scan(doc) {
    const holder = { doc: doc || newDoc() };
    const pages = doc ? await DB.getPages(doc) : [];
    const lastThumb = pages.length ? pages[pages.length - 1].thumb : null;
    const before = holder.doc.pageIds.length;
    await Camera.open({
      pageCount: before,
      lastThumb,
      onPage: page => addPage(holder, page).catch(err => {
        console.error(err);
        Utils.alert('Could not save the page', err.message || String(err));
        return null;
      })
    });
    afterAdding(holder.doc, before, !doc);
  }

  /** Import photos from the library into `doc` (or a new document). */
  async function importPhotos(doc) {
    const files = await Utils.pickFiles({ accept: 'image/*', multiple: true });
    if (!files) return;
    const holder = { doc: doc || newDoc() };
    const before = holder.doc.pageIds.length;
    for (let i = 0; i < files.length; i++) {
      let page;
      Utils.showLoading(files.length > 1 ? `Reading photo ${i + 1} of ${files.length}…` : 'Reading photo…');
      try {
        await Utils.nextFrame();
        const img = await Utils.blobToImage(files[i]);
        const { canvas, blob } = await Imaging.captureOriginal(img, img.naturalWidth, img.naturalHeight);
        const det = Imaging.detectQuad(canvas, canvas.width, canvas.height, 420);
        page = { canvas, blob, corners: det.corners };
      } catch (err) {
        Utils.hideLoading();
        await Utils.alert(`Photo ${i + 1} skipped`, err.message || String(err));
        continue;
      }
      Utils.hideLoading();
      try {
        await addPage(holder, page);
      } catch (err) {
        console.error(err);
        await Utils.alert('Could not save the page', err.message || String(err));
      } finally {
        Utils.freeCanvas(page.canvas);
      }
    }
    afterAdding(holder.doc, before, !doc);
  }

  function afterAdding(doc, before, isNew) {
    const added = doc.pageIds.length - before;
    if (added > 0) Utils.toast(`${added} page${added === 1 ? '' : 's'} added`);
    // Opening the same route again re-renders it, so an existing document refreshes
    if (added > 0 || !isNew) App.go('/doc/' + encodeURIComponent(doc.id));
  }

  // =========================================================
  // Document screen
  // =========================================================
  let reorderMode = false;

  async function renderDoc(id) {
    const doc = await DB.get('docs', id);
    if (!doc) return App.notFound('scan');
    const pages = await DB.getPages(doc);
    if (!pages.length) reorderMode = false;

    App.render({
      title: doc.name,
      back: '/', backLabel: 'Scans',
      right: `<button type="button" class="icon-btn" id="btn-more" aria-label="More">${ICONS.more}</button>`,
      body: `
        <button type="button" class="card name-card" id="btn-rename">
          <div class="card-title">${Utils.esc(doc.name)}</div>
          <div class="card-sub">${pages.length} page${pages.length === 1 ? '' : 's'} · Tap to rename</div>
        </button>
        <div class="section-title"><span>Pages</span>
          ${pages.length > 1 ? `<button type="button" class="link-btn" id="btn-reorder">${reorderMode ? 'Done' : 'Reorder'}</button>` : ''}</div>
        ${pages.length ? `<div class="page-grid ${reorderMode ? 'reorder' : ''}">${pages.map((p, i) => `
          <div class="page-tile">
            <a href="#/doc/${encodeURIComponent(doc.id)}/page/${encodeURIComponent(p.id)}" class="page-img">
              <img src="${p.thumb}" alt="Page ${i + 1}"></a>
            <span class="page-no">${i + 1}</span>
            ${reorderMode ? `<div class="move-btns">
              <button type="button" class="btn sm" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move earlier">${ICONS.left}</button>
              <button type="button" class="btn sm" data-move="${i}" data-dir="1" ${i === pages.length - 1 ? 'disabled' : ''} aria-label="Move later">${ICONS.right}</button>
            </div>` : ''}
          </div>`).join('')}</div>`
        : '<div class="empty">No pages. Tap <b>Add</b> to scan some.</div>'}`,
      actions: `
        <button type="button" class="btn" id="btn-add">${App.ICONS.camera}Add</button>
        <button type="button" class="btn primary grow2" id="btn-pdf" ${pages.length ? '' : 'disabled'}>${ICONS.pdf}Save PDF</button>`
    });

    document.getElementById('btn-rename').addEventListener('click', () => rename(doc));
    document.getElementById('btn-add').addEventListener('click', () => scan(doc));
    document.getElementById('btn-pdf').addEventListener('click', async () => {
      const updated = await PdfExport.exportDoc(doc);
      if (updated.name !== doc.name) renderDoc(id);
    });
    const reorderBtn = document.getElementById('btn-reorder');
    if (reorderBtn) reorderBtn.addEventListener('click', () => { reorderMode = !reorderMode; renderDoc(id); });
    document.querySelectorAll('[data-move]').forEach(b => b.addEventListener('click', async () => {
      const i = +b.dataset.move, j = i + +b.dataset.dir;
      const ids = doc.pageIds.slice();
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await saveOrder(doc, ids, pages);
      renderDoc(id);
    }));
    document.getElementById('btn-more').addEventListener('click', async () => {
      const choice = await Utils.actionSheet({
        title: doc.name,
        options: [
          { value: 'rename', label: 'Rename' },
          { value: 'import', label: 'Add pages from Photos' },
          { value: 'delete', label: 'Delete scan', danger: true }
        ]
      });
      if (choice === 'rename') rename(doc);
      else if (choice === 'import') importPhotos(doc);
      else if (choice === 'delete') {
        const ok = await Utils.confirm({
          title: 'Delete this scan?',
          message: `"${doc.name}" and its ${pages.length} page${pages.length === 1 ? '' : 's'} will be removed from this phone. PDFs you already saved to Files are not affected.`,
          confirmLabel: 'Delete', danger: true
        });
        if (!ok) return;
        await DB.deleteDoc(doc.id);
        Utils.toast('Scan deleted');
        App.go('/');
      }
    });
  }

  async function rename(doc) {
    const name = await Utils.prompt({ title: 'Rename scan', label: 'Name', value: doc.name });
    if (!name || name === doc.name) return;
    await DB.put('docs', { ...doc, name, modifiedAt: Utils.nowStamp() });
    renderDoc(doc.id);
  }

  /** Save a new page order; the first page's thumbnail becomes the document thumbnail. */
  async function saveOrder(doc, ids, pages) {
    const first = pages.find(p => p.id === ids[0]);
    await DB.put('docs', { ...doc, pageIds: ids, thumb: first ? first.thumb : doc.thumb, modifiedAt: Utils.nowStamp() });
  }

  // =========================================================
  // Page screen
  // =========================================================
  // The flattened (unfiltered) page is cached so switching looks is quick
  let flatCache = { key: null, canvas: null };
  let pageImageUrl = null;

  function cacheKey(page) { return page.id + JSON.stringify(page.corners); }

  async function getFlat(page) {
    const key = cacheKey(page);
    if (flatCache.key === key && flatCache.canvas) return flatCache.canvas;
    Utils.freeCanvas(flatCache.canvas);
    flatCache = { key: null, canvas: null };
    const images = await DB.get('pageImages', page.id);
    const src = await Imaging.originalCanvas(images.original);
    const flat = Imaging.warp(src, page.corners);
    Utils.freeCanvas(src);
    flatCache = { key, canvas: flat };
    return flat;
  }

  /** Show a page's text with a Copy button. */
  async function showText(text) {
    if (!text.trim()) {
      await Utils.alert('No text found', 'No readable text was found on this page. Try the B&W look or re-crop the page, then try again.');
      return;
    }
    await Utils.modal({
      title: 'Page text',
      bodyHtml: `<textarea class="ocr-text" readonly>${Utils.esc(text)}</textarea>
        <div class="hint small muted">Read automatically – check names and numbers before relying on them.</div>`,
      buttons: [
        { label: 'Close', value: null },
        { label: 'Copy', value: 'copy', className: 'primary' }
      ],
      getValue: el => {
        const ta = el.querySelector('textarea');
        const done = () => Utils.toast('Text copied');
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done, () => { ta.select(); document.execCommand('copy'); done(); });
        } else {
          ta.select();
          document.execCommand('copy');
          done();
        }
        return 'copied';
      }
    });
  }

  async function renderPage(docId, pageId) {
    const doc = await DB.get('docs', docId);
    if (!doc) return App.notFound('scan');
    const pages = await DB.getPages(doc);
    const index = pages.findIndex(p => p.id === pageId);
    if (index < 0) return App.notFound('page');
    let page = pages[index];
    const images = await DB.get('pageImages', page.id);

    if (pageImageUrl) URL.revokeObjectURL(pageImageUrl);
    pageImageUrl = images && images.processed ? URL.createObjectURL(images.processed) : page.thumb;
    const docPath = '/doc/' + encodeURIComponent(doc.id);
    const pagePath = p => `${docPath}/page/${encodeURIComponent(p.id)}`;

    App.render({
      title: `Page ${index + 1} of ${pages.length}`,
      back: docPath, backLabel: 'Pages',
      body: `
        <div class="page-view"><img src="${pageImageUrl}" alt="Page ${index + 1}"></div>
        <div class="pager">
          <button type="button" class="btn sm" id="pg-prev" ${index === 0 ? 'disabled' : ''}>${ICONS.left}Previous</button>
          <button type="button" class="btn sm" id="pg-next" ${index === pages.length - 1 ? 'disabled' : ''}>Next${ICONS.right}</button>
        </div>
        <div class="form-card">
          <div class="field">
            <span class="label">Look</span>
            <div class="segmented" id="pg-filter">${Imaging.FILTERS.map(f =>
              `<button type="button" data-value="${f.value}" class="${f.value === page.filter ? 'active' : ''}">${Utils.esc(f.label)}</button>`).join('')}</div>
          </div>
          <div class="tool-grid">
            <button type="button" class="btn" id="pg-crop">${ICONS.crop}Crop</button>
            <button type="button" class="btn" id="pg-rotl" aria-label="Rotate left">${ICONS.rotL}Left</button>
            <button type="button" class="btn" id="pg-rotr" aria-label="Rotate right">${ICONS.rotR}Right</button>
          </div>
          <div class="tool-grid two mt">
            <button type="button" class="btn" id="pg-earlier" ${index === 0 ? 'disabled' : ''}>Move earlier</button>
            <button type="button" class="btn" id="pg-later" ${index === pages.length - 1 ? 'disabled' : ''}>Move later</button>
          </div>
          <button type="button" class="btn block mt" id="pg-text">${ICONS.text}Copy text</button>
        </div>
        <button type="button" class="btn danger block" id="pg-delete">${ICONS.trash}Delete page</button>`
    });

    document.getElementById('pg-prev').addEventListener('click', () => App.go(pagePath(pages[index - 1])));
    document.getElementById('pg-next').addEventListener('click', () => App.go(pagePath(pages[index + 1])));

    /** Re-render this page with changed settings and save it. */
    async function update(changes, message) {
      const next = { ...page, ...changes, ocr: null };   // image changes, so its text must be read again
      Utils.showLoading(message);
      try {
        await Utils.nextFrame();
        const flat = await getFlat(next);
        const out = await Imaging.finish(flat, next.filter, next.rotation);
        next.width = out.width;
        next.height = out.height;
        next.thumb = out.thumb;
        const freshDoc = await DB.get('docs', doc.id);
        const updatedDoc = { ...freshDoc, modifiedAt: Utils.nowStamp() };
        if (freshDoc.pageIds[0] === page.id) updatedDoc.thumb = next.thumb;
        const imgs = await DB.get('pageImages', page.id);
        await DB.savePage({ doc: updatedDoc, page: next, images: { ...imgs, processed: out.blob } });
        page = next;
      } catch (err) {
        console.error(err);
        Utils.hideLoading();
        await Utils.alert('Could not update the page', err.message || String(err));
        return;
      }
      Utils.hideLoading();
      renderPage(doc.id, page.id);
    }

    document.getElementById('pg-filter').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.dataset.value === page.filter) return;
      update({ filter: b.dataset.value }, 'Applying…');
    });
    document.getElementById('pg-rotl').addEventListener('click', () => update({ rotation: ((page.rotation || 0) + 270) % 360 }, 'Rotating…'));
    document.getElementById('pg-rotr').addEventListener('click', () => update({ rotation: ((page.rotation || 0) + 90) % 360 }, 'Rotating…'));

    document.getElementById('pg-crop').addEventListener('click', async () => {
      Utils.showLoading('Opening photo…');
      let src;
      try {
        await Utils.nextFrame();
        const imgs = await DB.get('pageImages', page.id);
        src = await Imaging.originalCanvas(imgs.original);
      } finally {
        Utils.hideLoading();
      }
      const detected = Imaging.detectQuad(src, src.width, src.height, 420).corners;
      const res = await CropEditor.open({
        canvas: src, corners: page.corners, detected, cancelLabel: 'Cancel', confirmLabel: 'Done', title: 'Crop page'
      });
      Utils.freeCanvas(src);
      if (res === 'cancel') return;
      update({ corners: res.corners }, 'Flattening…');
    });

    document.getElementById('pg-text').addEventListener('click', async () => {
      if (!Ocr.hasText(page)) {
        Utils.showLoading('Starting text reader…');
        try {
          await Utils.nextFrame();
          [page] = await Ocr.ensure([page], (i, n, f) =>
            Utils.updateLoading(`Reading text…${f ? ` ${Math.round(f * 100)}%` : ''}`));
        } catch (err) {
          console.error(err);
          Utils.hideLoading();
          await Utils.alert('Could not read the text', err.message || String(err));
          return;
        } finally {
          Ocr.release();
        }
        Utils.hideLoading();
      }
      showText(page.ocr.text);
    });

    async function move(dir) {
      const ids = doc.pageIds.slice();
      const i = ids.indexOf(page.id), j = i + dir;
      [ids[i], ids[j]] = [ids[j], ids[i]];
      await saveOrder(doc, ids, pages);
      renderPage(doc.id, page.id);
    }
    document.getElementById('pg-earlier').addEventListener('click', () => move(-1));
    document.getElementById('pg-later').addEventListener('click', () => move(1));

    document.getElementById('pg-delete').addEventListener('click', async () => {
      const ok = await Utils.confirm({ title: 'Delete this page?', message: `Page ${index + 1} will be removed from "${doc.name}".`, confirmLabel: 'Delete', danger: true });
      if (!ok) return;
      const ids = doc.pageIds.filter(x => x !== page.id);
      const first = pages.find(p => p.id === ids[0]);
      await DB.deletePage({ ...doc, pageIds: ids, thumb: first ? first.thumb : null, modifiedAt: Utils.nowStamp() }, page.id);
      Utils.toast('Page deleted');
      const nextPage = pages[index + 1] || pages[index - 1];
      App.go(nextPage ? pagePath(nextPage) : docPath);
    });
  }

  return { renderList, renderDoc, renderPage, scan, importPhotos };
})();
