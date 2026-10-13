/* =========================================================
   settings.js – app settings + Settings screen
   ========================================================= */

const Settings = (() => {
  const DEFAULTS = {
    filter: 'color',        // look applied to new pages
    pageSize: 'a4',         // 'a4' | 'letter' | 'fit'
    reviewEachScan: true,   // show the corner editor after every photo
    autoCapture: false,     // take the photo automatically when the page is held steady
    ocr: true               // make PDFs searchable (read the text with OCR)
  };
  let current = { ...DEFAULTS };

  async function load() {
    const saved = await DB.get('settings', 'main');
    current = { ...DEFAULTS, ...(saved || {}) };
    return current;
  }

  function get() { return current; }

  async function save(changes) {
    current = { ...current, ...changes };
    await DB.put('settings', { key: 'main', ...current });
    return current;
  }

  function segmented(id, options, value) {
    return `<div class="segmented" id="${id}">${options.map(o =>
      `<button type="button" data-value="${o.value}" class="${o.value === value ? 'active' : ''}">${Utils.esc(o.label)}</button>`).join('')}</div>`;
  }

  async function render() {
    const s = get();
    let storage = '';
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const est = await navigator.storage.estimate();
        storage = `${Utils.formatBytes(est.usage || 0)} used`;
      } catch (e) { /* not available */ }
    }

    App.render({
      title: 'Settings',
      back: '/', backLabel: 'Scans',
      body: `
        <div class="section-title">New pages</div>
        <div class="form-card">
          <div class="field">
            <span class="label">Default look</span>
            ${segmented('set-filter', Imaging.FILTERS, s.filter)}
            <div class="hint">Colour cleans up the paper and keeps colours. B&amp;W is best for typed text. You can change each page later.</div>
          </div>
          <div class="field">
            <label class="switch-row"><span>Check corners after each photo</span>
              <input type="checkbox" id="set-review" ${s.reviewEachScan ? 'checked' : ''}></label>
            <div class="hint">Turn off for fast scanning of many pages. You can still fix any page's corners afterwards.</div>
          </div>
          <div class="field">
            <label class="switch-row"><span>Auto-capture</span>
              <input type="checkbox" id="set-auto" ${s.autoCapture ? 'checked' : ''}></label>
            <div class="hint">Takes the photo by itself when a page is found and held steady. Also switchable on the camera screen.</div>
          </div>
        </div>

        <div class="section-title">PDF</div>
        <div class="form-card">
          <div class="field">
            <span class="label">Default page size</span>
            ${segmented('set-size', PdfExport.PAGE_SIZES, s.pageSize)}
            <div class="hint">"Fit" makes each PDF page exactly the shape of the scan.</div>
          </div>
          <div class="field">
            <label class="switch-row"><span>Make text searchable</span>
              <input type="checkbox" id="set-ocr" ${s.ocr ? 'checked' : ''}></label>
            <div class="hint">Reads the text on each page (OCR, works offline) so PDFs can be searched and text copied. Also switchable when saving.</div>
          </div>
        </div>

        <div class="section-title">About</div>
        <div class="form-card small muted">
          <p style="margin-top:0">Scanner v${App.APP_VERSION}. Everything is stored only on this device${storage ? ` (${storage})` : ''}.
          Deleting the Home Screen app deletes your scans, so save PDFs you want to keep to Files.</p>
        </div>`
    });

    function wireSegmented(id, key) {
      const el = document.getElementById(id);
      el.addEventListener('click', async e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        el.querySelectorAll('button').forEach(b => b.classList.toggle('active', b === btn));
        await save({ [key]: btn.dataset.value });
        Utils.toast('Saved');
      });
    }
    wireSegmented('set-filter', 'filter');
    wireSegmented('set-size', 'pageSize');
    document.getElementById('set-review').addEventListener('change', e => save({ reviewEachScan: e.target.checked }));
    document.getElementById('set-auto').addEventListener('change', e => save({ autoCapture: e.target.checked }));
    document.getElementById('set-ocr').addEventListener('change', e => save({ ocr: e.target.checked }));
  }

  return { load, get, save, render };
})();
