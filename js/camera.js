/* =========================================================
   camera.js – full-screen live camera for scanning

   - Live viewfinder (back camera) with the detected page outlined
   - Flashlight toggle: stays on while the camera is open
     (needs a recent iOS; the button only appears if the phone reports support)
   - Low-light tip that offers to turn the flashlight on
   - Auto-capture: takes the photo when the page is held steady
   - Photos button: import existing photos instead
   - If the live camera can't start (permission denied, old iOS),
     falls back to the standard iPhone camera picker.

   Camera.open({ pageCount, lastThumb, onPage })
     onPage({ canvas, blob, corners }) is called for every photo and must
     resolve { thumb } when a page was saved, or null if it was discarded.
     Detection pauses while onPage runs (e.g. while the corner editor is open).
   Resolves when the user taps Done/Close.
   ========================================================= */

const Camera = (() => {
  const ICONS = {
    flash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
    photos: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>'
  };

  const DETECT_INTERVAL = 110;     // ms between detections (~9 per second)
  const STEADY_MS = 1100;          // auto-capture after the outline is steady this long
  const LOW_LIGHT = 60;            // average brightness (0–255) below which we suggest the flashlight

  function open({ pageCount = 0, lastThumb = null, onPage }) {
    return new Promise(resolve => {
      let count = pageCount;
      let stream = null, track = null;
      let torchOn = false, torchSupported = false;
      let auto = !!Settings.get().autoCapture;
      let busy = false;            // true while a photo is being handled
      let closed = false;
      let timer = null;
      let live = null;             // smoothed corners currently shown
      let missed = 0;              // consecutive frames with no page found
      let steadySince = 0;
      let lastRaw = null;
      let darkFrames = 0;
      // After a photo, auto-capture waits until that page leaves the view or
      // moves (i.e. you've turned to the next page) so it isn't captured twice.
      let lastShot = null;

      const el = document.createElement('div');
      el.className = 'fullscreen dark cam';
      el.innerHTML = `
        <div class="fs-top">
          <button type="button" class="btn dark sm" data-act="close">${count ? 'Done' : 'Cancel'}</button>
          <div class="fs-title" id="cam-title"></div>
          <div class="cam-top-right">
            <button type="button" class="round-btn" data-act="auto" aria-pressed="${auto}">AUTO</button>
            <button type="button" class="round-btn" data-act="torch" aria-label="Flashlight" hidden>${ICONS.flash}</button>
          </div>
        </div>
        <div class="fs-stage cam-stage">
          <video playsinline muted autoplay></video>
          <canvas class="cam-overlay"></canvas>
          <div class="cam-status" id="cam-status"></div>
          <button type="button" class="cam-tip" id="cam-tip" hidden></button>
          <div class="cam-fallback" id="cam-fallback" hidden></div>
          <div class="cam-flash"></div>
        </div>
        <div class="cam-bottom">
          <button type="button" class="round-btn lg" data-act="photos" aria-label="Import from Photos">${ICONS.photos}</button>
          <button type="button" class="shutter" data-act="shoot" aria-label="Take photo"><span></span></button>
          <button type="button" class="cam-thumb" data-act="close" aria-label="Done">
            ${lastThumb ? `<img src="${lastThumb}" alt="">` : ''}<b id="cam-count" ${count ? '' : 'hidden'}>${count}</b>
          </button>
        </div>`;
      document.getElementById('modal-root').appendChild(el);

      const video = el.querySelector('video');
      const overlay = el.querySelector('.cam-overlay');
      const octx = overlay.getContext('2d');
      const statusEl = el.querySelector('#cam-status');
      const tipEl = el.querySelector('#cam-tip');
      const torchBtn = el.querySelector('[data-act="torch"]');
      const autoBtn = el.querySelector('[data-act="auto"]');
      const titleEl = el.querySelector('#cam-title');

      function setTitle() { titleEl.textContent = `Page ${count + 1}`; }
      setTitle();

      // ---------- Camera start / stop ----------
      async function startCamera() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          showFallback('The live camera isn\'t available here.');
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              facingMode: { ideal: 'environment' },
              // 4:3 suits paper; the phone picks its closest supported size
              width: { ideal: 4032 }, height: { ideal: 3024 }
            }
          });
        } catch (err) {
          console.warn(err);
          showFallback(err && err.name === 'NotAllowedError'
            ? 'Camera access was not allowed. You can allow it in iPhone Settings → Safari → Camera, or use the iPhone camera below.'
            : 'The live camera could not start.');
          return;
        }
        if (closed) { stopCamera(); return; }
        track = stream.getVideoTracks()[0];
        video.srcObject = stream;
        try { await video.play(); } catch (e) { /* autoplay attribute handles it */ }
        await waitForVideo();
        checkTorch();
        if (torchOn) setTorch(true);   // restore after returning to the app
        scheduleDetect();
      }

      function waitForVideo() {
        return new Promise(r => {
          if (video.videoWidth) return r();
          video.addEventListener('loadedmetadata', () => r(), { once: true });
          setTimeout(r, 3000);
        });
      }

      function stopCamera() {
        clearTimeout(timer);
        if (stream) stream.getTracks().forEach(t => t.stop());   // also switches the flashlight off
        stream = null;
        track = null;
      }

      function showFallback(message) {
        const fb = el.querySelector('#cam-fallback');
        fb.hidden = false;
        fb.innerHTML = `<p>${Utils.esc(message)}</p>
          <button type="button" class="btn primary" data-act="native">Open iPhone Camera</button>`;
        el.querySelector('[data-act="shoot"]').disabled = true;
        autoBtn.hidden = true;
      }

      // ---------- Flashlight ----------
      function checkTorch() {
        try {
          const caps = track && track.getCapabilities ? track.getCapabilities() : {};
          torchSupported = !!caps.torch;
        } catch (e) { torchSupported = false; }
        torchBtn.hidden = !torchSupported;
      }

      async function setTorch(on) {
        if (!track) return;
        try {
          await track.applyConstraints({ advanced: [{ torch: on }] });
          torchOn = on;
        } catch (err) {
          console.warn(err);
          Utils.toast('The flashlight could not be switched');
          torchOn = false;
        }
        torchBtn.classList.toggle('on', torchOn);
        torchBtn.setAttribute('aria-pressed', torchOn);
        updateTip();
      }

      function updateTip() {
        const dark = darkFrames > 8;
        if (!dark || torchOn) { tipEl.hidden = true; return; }
        tipEl.hidden = false;
        tipEl.textContent = torchSupported ? 'Low light – tap to turn on the flashlight' : 'Low light – move somewhere brighter';
        tipEl.disabled = !torchSupported;
      }

      // ---------- Live detection ----------
      function scheduleDetect() {
        clearTimeout(timer);
        if (closed) return;
        timer = setTimeout(detectFrame, DETECT_INTERVAL);
      }

      function detectFrame() {
        if (closed || !stream) return;
        if (busy || !video.videoWidth || video.readyState < 2) { scheduleDetect(); return; }
        let result;
        try {
          result = Imaging.detectQuad(video, video.videoWidth, video.videoHeight);
        } catch (err) {
          console.warn(err);
          scheduleDetect();
          return;
        }
        darkFrames = result.brightness < LOW_LIGHT ? darkFrames + 1 : 0;
        updateTip();

        const now = performance.now();
        if (result.corners) {
          missed = 0;
          const raw = result.corners;
          const move = lastRaw ? avgDist(raw, lastRaw) : 1;
          lastRaw = raw;
          if (!live || avgDist(raw, live) > 0.08) live = raw.map(p => ({ ...p }));
          else live = live.map((p, i) => ({ x: p.x * 0.5 + raw[i].x * 0.5, y: p.y * 0.5 + raw[i].y * 0.5 }));
          if (move < 0.012) { if (!steadySince) steadySince = now; }
          else steadySince = 0;
        } else {
          missed++;
          steadySince = 0;
          lastRaw = null;
          if (missed > 4) { live = null; lastShot = null; }
        }
        if (lastShot && live && avgDist(live, lastShot) > 0.06) lastShot = null;
        const armed = auto && !lastShot;

        const steadyFor = steadySince ? now - steadySince : 0;
        if (live && auto && !armed) {
          statusEl.textContent = 'Got it – show the next page';
        } else if (live) {
          statusEl.textContent = auto ? (steadyFor > 250 ? 'Hold steady…' : 'Page found') : 'Page found – tap the button';
        } else {
          statusEl.textContent = 'Looking for a page…';
        }
        drawOverlay(armed && live ? Math.min(1, steadyFor / STEADY_MS) : 0);

        if (armed && live && steadyFor >= STEADY_MS) {
          steadySince = 0;
          shoot();
          return;
        }
        scheduleDetect();
      }

      function avgDist(a, b) {
        let s = 0;
        for (let i = 0; i < 4; i++) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
        return s / 4;
      }

      /** Video is shown with object-fit: contain – work out where it sits. */
      function videoRect() {
        const r = overlay.getBoundingClientRect();
        const vw = video.videoWidth || 1, vh = video.videoHeight || 1;
        const s = Math.min(r.width / vw, r.height / vh);
        return { cssW: r.width, cssH: r.height, x: (r.width - vw * s) / 2, y: (r.height - vh * s) / 2, w: vw * s, h: vh * s };
      }

      function drawOverlay(progress) {
        const r = videoRect();
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const W = Math.round(r.cssW * dpr), H = Math.round(r.cssH * dpr);
        if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
        octx.setTransform(dpr, 0, 0, dpr, 0, 0);
        octx.clearRect(0, 0, r.cssW, r.cssH);
        if (!live) return;
        const s = live.map(p => ({ x: r.x + p.x * r.w, y: r.y + p.y * r.h }));
        octx.beginPath();
        s.forEach((p, i) => i ? octx.lineTo(p.x, p.y) : octx.moveTo(p.x, p.y));
        octx.closePath();
        octx.fillStyle = `rgba(77,163,255,${0.18 + progress * 0.25})`;
        octx.fill();
        octx.lineWidth = 3;
        octx.strokeStyle = progress >= 1 ? '#34c759' : '#4da3ff';
        octx.stroke();
      }

      // ---------- Taking a photo ----------
      async function shoot() {
        if (busy || closeRequested || !stream || !video.videoWidth) return;
        busy = true;
        el.classList.add('flashing');
        setTimeout(() => el.classList.remove('flashing'), 180);
        try {
          const { canvas, blob } = await Imaging.captureOriginal(video, video.videoWidth, video.videoHeight);
          // Detect again on the still photo at higher resolution (more accurate than the live outline)
          const still = Imaging.detectQuad(canvas, canvas.width, canvas.height, 420);
          const corners = still.corners || (live ? live.map(p => ({ ...p })) : null);
          await handlePage({ canvas, blob, corners });
        } catch (err) {
          console.error(err);
          Utils.alert('Photo failed', err.message || String(err));
        } finally {
          lastShot = live;
          live = lastShot ? lastShot.map(p => ({ ...p })) : null;
          lastRaw = null; steadySince = 0;
          busy = false;
          if (closeRequested) close();
          else scheduleDetect();
        }
      }

      async function handlePage(page) {
        const res = await onPage(page);
        Utils.freeCanvas(page.canvas);
        if (res) {
          count++;
          setTitle();
          const thumbBtn = el.querySelector('.cam-thumb');
          thumbBtn.innerHTML = `<img src="${res.thumb}" alt=""><b id="cam-count">${count}</b>`;
          el.querySelector('[data-act="close"]').textContent = 'Done';
        }
      }

      /** Photos picked from the library or taken with the iPhone camera app. */
      async function handleFiles(files) {
        if (!files) return;
        busy = true;
        try {
          for (let i = 0; i < files.length; i++) {
            Utils.showLoading(files.length > 1 ? `Reading photo ${i + 1} of ${files.length}…` : 'Reading photo…');
            await Utils.nextFrame();
            let page;
            try {
              const img = await Utils.blobToImage(files[i]);
              const { canvas, blob } = await Imaging.captureOriginal(img, img.naturalWidth, img.naturalHeight);
              const det = Imaging.detectQuad(canvas, canvas.width, canvas.height, 420);
              page = { canvas, blob, corners: det.corners };
            } finally {
              Utils.hideLoading();
            }
            await handlePage(page);
          }
        } catch (err) {
          console.error(err);
          Utils.alert('Photo failed', err.message || String(err));
        } finally {
          busy = false;
          if (closeRequested) close();
          else scheduleDetect();
        }
      }

      // ---------- Buttons ----------
      el.addEventListener('click', async e => {
        if (e.target === tipEl) { if (torchSupported) setTorch(true); return; }
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === 'close') close();
        else if (act === 'shoot') shoot();
        else if (act === 'torch') setTorch(!torchOn);
        else if (act === 'auto') {
          auto = !auto;
          autoBtn.setAttribute('aria-pressed', auto);
          steadySince = 0;
          Utils.toast(auto ? 'Auto-capture on – hold the phone steady over the page' : 'Auto-capture off');
        } else if (act === 'photos') {
          handleFiles(await Utils.pickFiles({ accept: 'image/*', multiple: true }));
        } else if (act === 'native') {
          handleFiles(await Utils.pickFiles({ accept: 'image/*', capture: 'environment' }));
        }
      });

      // iPhone stops the camera when the app goes to the background – restart on return
      function onVisibility() {
        if (closed) return;
        if (document.hidden) stopCamera();
        else if (!stream && !el.querySelector('#cam-fallback:not([hidden])')) startCamera();
      }
      document.addEventListener('visibilitychange', onVisibility);

      let closeRequested = false;
      function close() {
        // A photo is still being saved – close as soon as it's done (no new photos meanwhile)
        if (busy) { closeRequested = true; auto = false; return; }
        closed = true;
        document.removeEventListener('visibilitychange', onVisibility);
        stopCamera();
        el.remove();
        resolve(count);
      }

      startCamera();
    });
  }

  return { open };
})();
