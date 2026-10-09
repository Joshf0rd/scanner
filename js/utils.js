/* =========================================================
   utils.js – shared helpers
   - IDs, dates, HTML escaping, file names
   - Image / blob helpers
   - Saving/sharing files
   - UI: modal dialogs, toast messages, loading overlay
   ========================================================= */

const Utils = (() => {

  // ---------- IDs ----------
  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for older browsers
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // ---------- Dates ----------
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  function pad(n, len = 2) { return String(n).padStart(len, '0'); }

  /** Current moment as an ISO timestamp (for created/modified fields). */
  function nowStamp() { return new Date().toISOString(); }

  /** ISO timestamp -> '7 Oct 2026' (local time) */
  function formatDateShort(stamp) {
    const d = new Date(stamp);
    if (isNaN(d)) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }

  /** ISO timestamp -> '7 October 2026, 14:32' (local time) */
  function formatStamp(stamp) {
    const d = new Date(stamp);
    if (isNaN(d)) return '';
    return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  /** Default name for a new scan, e.g. 'Scan 9 Oct 2026 14.32' */
  function defaultScanName() {
    const d = new Date();
    return `Scan ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
  }

  // ---------- Text ----------
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * Make a document name safe for use as a file name.
   * Spaces are kept (they look nicer in the Files app); only characters that
   * file systems reject are replaced.
   */
  function safeFileName(text) {
    return String(text || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[\s.]+|[\s.]+$/g, '')
      .slice(0, 80) || 'Scan';
  }

  // ---------- Images ----------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('This image could not be read. Try a JPEG or PNG photo.'));
      img.src = src;
    });
  }

  /** Load a Blob/File as an <img>. Modern browsers apply EXIF rotation automatically. */
  async function blobToImage(blob) {
    const url = URL.createObjectURL(blob);
    try {
      return await loadImage(url);
    } finally {
      // Image is fully decoded once onload fires; the URL is no longer needed
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }

  function canvasToBlob(canvas, mime = 'image/jpeg', quality = 0.85) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('Could not save the image (out of memory?)')), mime, quality);
    });
  }

  /** Release a canvas's memory promptly (important on iPhone, which has a low canvas memory limit). */
  function freeCanvas(canvas) {
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }

  // ---------- Files ----------
  /**
   * Show a "file ready" dialog with Share (iPhone share sheet, when supported)
   * and Download buttons. A dialog is used because iPhone only allows the share
   * sheet to open directly after a tap – not after a long PDF generation.
   * Resolves true if the file was shared or downloaded at least once.
   */
  async function offerFile(blob, fileName, { title, message = '' }) {
    const file = new File([blob], fileName, { type: blob.type });
    let canShareFiles = false;
    try { canShareFiles = !!(navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { /* no */ }

    let delivered = false;
    for (;;) {
      const buttons = [{ label: delivered ? 'Done' : 'Close', value: null }];
      buttons.push({ label: 'Download', value: 'download', className: canShareFiles ? '' : 'primary' });
      if (canShareFiles) buttons.push({ label: 'Share / Save', value: 'share', className: 'primary' });
      const choice = await modal({
        title,
        message: `${message ? message + '\n\n' : ''}${fileName}\n${formatBytes(blob.size)}`,
        buttons
      });
      if (!choice) return delivered;
      if (choice === 'download') {
        downloadBlob(blob, fileName);
        delivered = true;
        toast('Download started');
      } else {
        try {
          await navigator.share({ files: [file], title: fileName });
          delivered = true;
        } catch (err) {
          if (!err || err.name !== 'AbortError') {
            toast('Sharing failed – try Download instead');
          }
        }
      }
    }
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /**
   * Open a hidden file picker and resolve with the chosen files (or null).
   * capture: 'environment' opens the iPhone camera directly.
   */
  function pickFiles({ accept = '*/*', multiple = false, capture = null } = {}) {
    return new Promise(resolve => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.multiple = multiple;
      if (capture) input.setAttribute('capture', capture);
      input.style.display = 'none';
      input.addEventListener('change', () => {
        resolve(input.files && input.files.length ? Array.from(input.files) : null);
        input.remove();
      });
      document.body.appendChild(input);
      input.click();
    });
  }

  // ---------- UI: toast ----------
  let toastTimer = null;
  function toast(message, ms = 2200) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ---------- UI: loading overlay ----------
  function showLoading(message = 'Working…') {
    hideLoading();
    const el = document.createElement('div');
    el.className = 'loading';
    el.id = 'loading-overlay';
    el.innerHTML = `<div class="spinner"></div><div class="loading-msg">${esc(message)}</div>`;
    document.body.appendChild(el);
  }
  function updateLoading(message) {
    const el = document.querySelector('#loading-overlay .loading-msg');
    if (el) el.textContent = message;
  }
  function hideLoading() {
    const el = document.getElementById('loading-overlay');
    if (el) el.remove();
  }

  /**
   * Let the browser repaint (e.g. show a loading message) before heavy work.
   * The timeout is a fallback: animation frames pause while the app is in the
   * background, and saving must not stall because of that.
   */
  function nextFrame() {
    return new Promise(r => {
      let done = false;
      const go = () => { if (!done) { done = true; setTimeout(r, 0); } };
      requestAnimationFrame(go);
      setTimeout(go, 60);
    });
  }

  // ---------- UI: modal ----------
  /**
   * Generic modal. `buttons` = [{ label, value, className }].
   * Resolves with the clicked button's value (or null if dismissed).
   * `onOpen(modalEl)` can wire up extra content; `getValue(modalEl, value)` can
   * transform the result (e.g. read a field).
   */
  function modal({ title, message = '', bodyHtml = '', buttons, onOpen, getValue, dismissible = true }) {
    return new Promise(resolve => {
      const root = document.getElementById('modal-root');
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';
      backdrop.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true">
          <h2>${esc(title)}</h2>
          ${message ? `<p>${esc(message)}</p>` : ''}
          ${bodyHtml}
          <div class="modal-actions">
            ${buttons.map((b, i) => `<button type="button" class="btn ${b.className || ''}" data-i="${i}">${esc(b.label)}</button>`).join('')}
          </div>
        </div>`;
      const modalEl = backdrop.querySelector('.modal');

      function close(value) {
        backdrop.remove();
        resolve(value);
      }
      backdrop.addEventListener('click', e => {
        if (e.target === backdrop && dismissible) close(null);
      });
      backdrop.querySelectorAll('.modal-actions button').forEach(btn => {
        btn.addEventListener('click', () => {
          const b = buttons[+btn.dataset.i];
          if (b.value === null || !getValue) return close(b.value);
          const v = getValue(modalEl, b.value);
          if (v !== undefined) close(v);   // getValue returns undefined to keep the dialog open
        });
      });
      root.appendChild(backdrop);
      if (onOpen) onOpen(modalEl, close);
    });
  }

  /** Yes/No confirmation. Resolves true/false. */
  async function confirm({ title, message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false }) {
    const v = await modal({
      title, message,
      buttons: [
        { label: cancelLabel, value: false },
        { label: confirmLabel, value: true, className: danger ? 'danger-solid' : 'primary' }
      ]
    });
    return v === true;
  }

  function alert(title, message) {
    return modal({ title, message, buttons: [{ label: 'OK', value: true, className: 'primary' }] });
  }

  /** Single text field dialog. Resolves the trimmed text, or null if cancelled. */
  function prompt({ title, message = '', label = '', value = '', confirmLabel = 'Save', required = true }) {
    return modal({
      title, message,
      bodyHtml: `<div class="field"><label for="prompt-input">${esc(label)}</label>
        <input type="text" id="prompt-input" value="${esc(value)}" autocomplete="off" enterkeyhint="done"></div>`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: confirmLabel, value: 'ok', className: 'primary' }
      ],
      onOpen: el => {
        const input = el.querySelector('#prompt-input');
        input.focus();
        input.select();
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') el.querySelector('.modal-actions .primary').click();
        });
      },
      getValue: el => {
        const input = el.querySelector('#prompt-input');
        const v = input.value.trim();
        if (required && !v) {
          input.closest('.field').classList.add('invalid');
          input.focus();
          return undefined;
        }
        return v;
      }
    });
  }

  /** Radio choice dialog. options = [{ value, label }]. Resolves chosen value or null. */
  function choose({ title, message, options, initial, confirmLabel = 'OK' }) {
    const name = 'choice-' + Date.now();
    return modal({
      title, message,
      bodyHtml: `<div class="choice">${options.map(o => `
        <label><input type="radio" name="${name}" value="${esc(o.value)}" ${o.value === initial ? 'checked' : ''}> ${esc(o.label)}</label>`).join('')}
      </div>`,
      buttons: [
        { label: 'Cancel', value: null },
        { label: confirmLabel, value: 'ok', className: 'primary' }
      ],
      getValue: el => {
        const checked = el.querySelector(`input[name="${name}"]:checked`);
        return checked ? checked.value : undefined;
      }
    });
  }

  /** Action sheet: a list of buttons. options = [{ value, label, danger }]. Resolves value or null. */
  function actionSheet({ title, options }) {
    return modal({
      title,
      bodyHtml: `<div class="sheet-list">${options.map((o, i) =>
        `<button type="button" class="btn block ${o.danger ? 'danger' : ''}" data-sheet="${i}">${esc(o.label)}</button>`).join('')}</div>`,
      buttons: [{ label: 'Cancel', value: null }],
      onOpen: (el, close) => {
        el.querySelectorAll('[data-sheet]').forEach(b =>
          b.addEventListener('click', () => close(options[+b.dataset.sheet].value)));
      }
    });
  }

  // ---------- Misc ----------
  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  return {
    uid, nowStamp, formatDateShort, formatStamp, defaultScanName, pad,
    esc, safeFileName,
    loadImage, blobToImage, canvasToBlob, freeCanvas,
    offerFile, downloadBlob, pickFiles,
    toast, showLoading, updateLoading, hideLoading, nextFrame,
    modal, confirm, alert, prompt, choose, actionSheet, formatBytes
  };
})();
