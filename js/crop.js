/* =========================================================
   crop.js – full-screen corner editor

   Shows the photo with the detected page outline. Drag the four
   round handles onto the page corners (a magnifier shows exactly
   where your finger is), or drag the bar handles to move a whole edge.

   CropEditor.open({ canvas, corners, cancelLabel, title })
     resolves { corners }   – Keep
              'cancel'      – Retake / Cancel
   ========================================================= */

const CropEditor = (() => {

  /** `detected` (optional) is what "Use detected page" returns to; it defaults to `corners`. */
  function open({ canvas, corners, detected = corners, cancelLabel = 'Retake', confirmLabel = 'Keep scan', title = 'Adjust corners' }) {
    return new Promise(resolve => {
      detected = detected ? detected.map(p => ({ ...p })) : null;
      let pts = (corners || Imaging.fullFrameCorners()).map(p => ({ ...p }));
      const same = (a, b) => a.every((p, i) => Math.abs(p.x - b[i].x) < 1e-4 && Math.abs(p.y - b[i].y) < 1e-4);
      let usingDetected = !!(detected && corners && same(corners, detected));

      const el = document.createElement('div');
      el.className = 'fullscreen dark crop';
      el.innerHTML = `
        <div class="fs-top">
          <button type="button" class="btn dark sm" data-act="cancel">${Utils.esc(cancelLabel)}</button>
          <div class="fs-title">${Utils.esc(title)}</div>
          <button type="button" class="btn primary sm" data-act="keep">${Utils.esc(confirmLabel)}</button>
        </div>
        <div class="fs-stage"><canvas></canvas></div>
        <div class="fs-tools">
          <div class="fs-row">
            <button type="button" class="btn dark sm" data-act="toggle"></button>
          </div>
          <div class="fs-hint">Drag the circles onto the corners of the page</div>
        </div>`;
      document.getElementById('modal-root').appendChild(el);

      const stage = el.querySelector('.fs-stage');
      const cv = el.querySelector('canvas');
      const ctx = cv.getContext('2d');
      const toggleBtn = el.querySelector('[data-act="toggle"]');
      const imgW = canvas.width, imgH = canvas.height;
      let view = { ox: 0, oy: 0, dw: 1, dh: 1, cssW: 1, cssH: 1, dpr: 1 };
      let drag = null;   // { kind: 'corner'|'edge', index, startPts, startX, startY }

      function updateToggle() {
        toggleBtn.textContent = detected && !usingDetected ? 'Use detected page' : 'Use whole photo';
      }

      function layout() {
        const r = stage.getBoundingClientRect();
        const pad = 24;   // room for the handles at the image edge
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        const cssW = Math.max(50, r.width), cssH = Math.max(50, r.height);
        cv.style.width = cssW + 'px';
        cv.style.height = cssH + 'px';
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
        const scale = Math.min((cssW - pad * 2) / imgW, (cssH - pad * 2) / imgH);
        const dw = imgW * scale, dh = imgH * scale;
        view = { ox: (cssW - dw) / 2, oy: (cssH - dh) / 2, dw, dh, cssW, cssH, dpr };
        draw();
      }

      const toScreen = p => ({ x: view.ox + p.x * view.dw, y: view.oy + p.y * view.dh });
      const clamp01 = v => Math.max(0, Math.min(1, v));

      function valid() {
        return Imaging.cornersValid(pts.map(p => ({ x: p.x * imgW, y: p.y * imgH })));
      }

      function draw() {
        const { dpr, cssW, cssH } = view;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(canvas, view.ox, view.oy, view.dw, view.dh);

        const s = pts.map(toScreen);
        const ok = valid();
        // Dim everything outside the page
        ctx.save();
        ctx.beginPath();
        ctx.rect(view.ox, view.oy, view.dw, view.dh);
        ctx.moveTo(s[0].x, s[0].y);
        for (let i = 3; i >= 1; i--) ctx.lineTo(s[i].x, s[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fill('evenodd');
        ctx.restore();

        ctx.beginPath();
        s.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
        ctx.closePath();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = ok ? '#4da3ff' : '#ff5a4f';
        ctx.stroke();

        // Edge handles (bars at the middle of each side)
        for (let i = 0; i < 4; i++) {
          const a = s[i], b = s[(i + 1) % 4];
          const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
          const ang = Math.atan2(b.y - a.y, b.x - a.x);
          ctx.save();
          ctx.translate(mx, my);
          ctx.rotate(ang);
          ctx.fillStyle = '#fff';
          ctx.strokeStyle = ok ? '#4da3ff' : '#ff5a4f';
          ctx.lineWidth = 2;
          roundRect(ctx, -14, -4, 28, 8, 4);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
        // Corner handles
        s.forEach((p, i) => {
          ctx.beginPath();
          ctx.arc(p.x, p.y, drag && drag.kind === 'corner' && drag.index === i ? 16 : 13, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(77,163,255,0.25)';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        });

        if (drag && drag.kind === 'corner') drawLoupe(s[drag.index], pts[drag.index]);
      }

      function roundRect(c, x, y, w, h, r) {
        c.beginPath();
        c.moveTo(x + r, y);
        c.arcTo(x + w, y, x + w, y + h, r);
        c.arcTo(x + w, y + h, x, y + h, r);
        c.arcTo(x, y + h, x, y, r);
        c.arcTo(x, y, x + w, y, r);
        c.closePath();
      }

      /** Magnifier in the top corner away from the finger. */
      function drawLoupe(screenPt, imgPt) {
        const R = 56, zoom = 3;
        const cx = screenPt.x < view.cssW / 2 ? view.cssW - R - 12 : R + 12;
        const cy = R + 12;
        const srcSize = (R * 2 / zoom) * (imgW / view.dw);   // image pixels shown in the loupe
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = '#000';
        ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
        ctx.drawImage(canvas,
          imgPt.x * imgW - srcSize / 2, imgPt.y * imgH - srcSize / 2, srcSize, srcSize,
          cx - R, cy - R, R * 2, R * 2);
        ctx.strokeStyle = '#4da3ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy);
        ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }

      function localPoint(e) {
        const r = cv.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
      }

      cv.addEventListener('pointerdown', e => {
        const p = localPoint(e);
        const s = pts.map(toScreen);
        let best = null, bestD = 44;
        s.forEach((q, i) => {
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bestD) { bestD = d; best = { kind: 'corner', index: i }; }
        });
        if (!best) {
          for (let i = 0; i < 4; i++) {
            const a = s[i], b = s[(i + 1) % 4];
            const d = Math.hypot((a.x + b.x) / 2 - p.x, (a.y + b.y) / 2 - p.y);
            if (d < bestD) { bestD = d; best = { kind: 'edge', index: i }; }
          }
        }
        if (!best) return;
        e.preventDefault();
        cv.setPointerCapture(e.pointerId);
        drag = { ...best, startPts: pts.map(q => ({ ...q })), startX: p.x, startY: p.y };
        draw();
      });

      cv.addEventListener('pointermove', e => {
        if (!drag) return;
        e.preventDefault();
        const p = localPoint(e);
        const dx = (p.x - drag.startX) / view.dw, dy = (p.y - drag.startY) / view.dh;
        const moved = drag.kind === 'corner' ? [drag.index] : [drag.index, (drag.index + 1) % 4];
        moved.forEach(i => {
          pts[i] = { x: clamp01(drag.startPts[i].x + dx), y: clamp01(drag.startPts[i].y + dy) };
        });
        usingDetected = false;
        draw();
      });

      const endDrag = () => {
        if (!drag) return;
        drag = null;
        updateToggle();
        draw();
      };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);

      function close(value) {
        window.removeEventListener('resize', layout);
        el.remove();
        resolve(value);
      }

      el.addEventListener('click', e => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'cancel') close('cancel');
        else if (act.dataset.act === 'keep') {
          if (!valid()) {
            Utils.toast('The outline is twisted – drag the corners into place');
            return;
          }
          const ordered = Imaging.orderCorners(pts.map(p => ({ x: p.x * imgW, y: p.y * imgH })))
            .map(p => ({ x: p.x / imgW, y: p.y / imgH }));
          close({ corners: ordered });
        } else if (act.dataset.act === 'toggle') {
          if (detected && !usingDetected) {
            pts = detected.map(p => ({ ...p }));
            usingDetected = true;
          } else {
            pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
            usingDetected = false;
          }
          updateToggle();
          draw();
        }
      });

      window.addEventListener('resize', layout);
      updateToggle();
      requestAnimationFrame(layout);
    });
  }

  return { open };
})();
