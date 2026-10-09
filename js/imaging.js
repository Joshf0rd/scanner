/* =========================================================
   imaging.js – all the image work, in plain JavaScript (no libraries)

   1. detectQuad()  – finds the page in a camera frame / photo
   2. warp()        – flattens the page (perspective correction)
   3. applyFilter() – Original / Colour / Grey / B&W clean-up
   4. rotate(), thumbnails, and processPage() which runs it all

   How page detection works (fast enough to run several times a second):
   - Shrink the frame to ~240 px and score each pixel for "paper-ness"
     (bright AND not very colourful – white paper has a high minimum RGB).
   - Blur, then split into foreground/background with Otsu's threshold.
   - Find connected blobs (both "bright on dark" and "dark on bright").
   - For each big blob: convex hull → best 4-corner shape → straight lines
     fitted to each edge → corners where the lines meet.
   - The blob that is large, fills its 4-corner shape well, and is not the
     background around the frame edges wins.
   It works best with a page on a darker or contrasting surface. White
   paper on a white desk is hard for any detector – drag the corners then.
   ========================================================= */

const Imaging = (() => {

  const FILTERS = [
    { value: 'original', label: 'Original' },
    { value: 'color', label: 'Colour' },
    { value: 'grey', label: 'Grey' },
    { value: 'bw', label: 'B&W' }
  ];

  // Photo as taken is kept at up to 2800 px on the long edge (so pages can be
  // re-cropped later). 2800 × 2100 is ~6 MP – safely under iPhone's canvas limits.
  const MAX_ORIGINAL = 2800;
  // Finished page: up to 2200 px tall ≈ 190 dpi on A4 – crisp text, ~300–600 KB per page.
  const MAX_OUTPUT = 2200;
  const OUTPUT_QUALITY = 0.82;
  const THUMB_MAX = 320;

  // ---------- Canvas helpers ----------
  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** Draw any image/video/canvas into a new canvas, scaled so the long edge ≤ maxDim. */
  function drawToCanvas(source, sw, sh, maxDim) {
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const c = makeCanvas(sw * scale, sh * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  }

  /** Default corners: the whole image, slightly inset. */
  function fullFrameCorners(inset = 0.04) {
    return [
      { x: inset, y: inset }, { x: 1 - inset, y: inset },
      { x: 1 - inset, y: 1 - inset }, { x: inset, y: 1 - inset }
    ];
  }

  // =========================================================
  // 1. Page detection
  // =========================================================
  let detectCanvas = null;

  /**
   * Find the page in `source` (video, img or canvas of size sw × sh).
   * Returns { corners: [TL,TR,BR,BL] as fractions 0–1, brightness 0–255 } –
   * corners is null when no page-like shape was found.
   */
  function detectQuad(source, sw, sh, maxDim = 240) {
    const scale = Math.min(1, maxDim / Math.max(sw, sh));
    const W = Math.max(8, Math.round(sw * scale));
    const H = Math.max(8, Math.round(sh * scale));
    if (!detectCanvas) detectCanvas = document.createElement('canvas');
    if (detectCanvas.width !== W || detectCanvas.height !== H) {
      detectCanvas.width = W;
      detectCanvas.height = H;
    }
    const ctx = detectCanvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, W, H);
    const data = ctx.getImageData(0, 0, W, H).data;
    return detectInPixels(data, W, H);
  }

  function detectInPixels(data, W, H) {
    const N = W * H;
    // "Paper-ness" score: half brightness, half minimum channel
    let score = new Float32Array(N);
    let lumSum = 0;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      const r = data[j], g = data[j + 1], b = data[j + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumSum += lum;
      score[i] = 0.5 * lum + 0.5 * Math.min(r, g, b);
    }
    const brightness = lumSum / N;
    score = boxBlur(boxBlur(score, W, H, 1), W, H, 1);

    const t = otsu(score);
    if (t === null) return { corners: null, brightness };

    let best = null;
    for (const bright of [true, false]) {
      const mask = new Uint8Array(N);
      for (let i = 0; i < N; i++) mask[i] = (bright ? score[i] > t : score[i] <= t) ? 1 : 0;
      const eroded = erode(mask, W, H);
      const comps = components(eroded, W, H);
      comps.sort((a, b) => b.area - a.area);
      for (const comp of comps.slice(0, 3)) {
        if (comp.area < N * 0.06) break;
        const cand = evaluate(comp, W, H);
        if (cand && (!best || cand.score > best.score)) best = cand;
      }
    }
    if (!best) return { corners: null, brightness };
    // Pull the corners 0.6% towards the middle so no sliver of desk shows at the page edge
    const mx = best.quad.reduce((s, p) => s + p.x, 0) / 4;
    const my = best.quad.reduce((s, p) => s + p.y, 0) / 4;
    const corners = best.quad.map(p => ({
      x: Math.min(1, Math.max(0, (p.x + (mx - p.x) * 0.012) / W)),
      y: Math.min(1, Math.max(0, (p.y + (my - p.y) * 0.012) / H))
    }));
    return { corners, brightness };
  }

  /** Separable box blur with radius r. */
  function boxBlur(src, W, H, r) {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const xx = x + k;
          if (xx >= 0 && xx < W) { s += src[row + xx]; n++; }
        }
        tmp[row + x] = s / n;
      }
    }
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        let s = 0, n = 0;
        for (let k = -r; k <= r; k++) {
          const yy = y + k;
          if (yy >= 0 && yy < H) { s += tmp[yy * W + x]; n++; }
        }
        out[y * W + x] = s / n;
      }
    }
    return out;
  }

  /** Otsu's method: the threshold that best separates two groups of values (0–255). */
  function otsu(values) {
    const hist = new Float64Array(256);
    for (let i = 0; i < values.length; i++) hist[Math.max(0, Math.min(255, values[i] | 0))]++;
    const total = values.length;
    let sumAll = 0;
    for (let i = 0; i < 256; i++) sumAll += i * hist[i];
    let wB = 0, sumB = 0, bestVar = -1, bestT = null;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF;
      const v = wB * wF * (mB - mF) * (mB - mF);
      if (v > bestVar) { bestVar = v; bestT = t; }
    }
    // Very low contrast (e.g. blank wall) – nothing to find
    if (bestVar / (total * total) < 60) return null;
    return bestT;
  }

  /** 3×3 erosion – breaks thin bridges between the page and other bright things. */
  function erode(mask, W, H) {
    const out = new Uint8Array(mask.length);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (mask[i] && mask[i - 1] && mask[i + 1] && mask[i - W] && mask[i + W] &&
            mask[i - W - 1] && mask[i - W + 1] && mask[i + W - 1] && mask[i + W + 1]) out[i] = 1;
      }
    }
    return out;
  }

  /** Connected blobs (4-connected). Returns [{ label, area, labels }]. */
  function components(mask, W, H) {
    const labels = new Int32Array(mask.length);
    const stack = new Int32Array(mask.length);
    const comps = [];
    let next = 1;
    for (let start = 0; start < mask.length; start++) {
      if (!mask[start] || labels[start]) continue;
      const label = next++;
      let sp = 0, area = 0;
      stack[sp++] = start;
      labels[start] = label;
      while (sp) {
        const i = stack[--sp];
        area++;
        const x = i % W;
        if (x > 0 && mask[i - 1] && !labels[i - 1]) { labels[i - 1] = label; stack[sp++] = i - 1; }
        if (x < W - 1 && mask[i + 1] && !labels[i + 1]) { labels[i + 1] = label; stack[sp++] = i + 1; }
        if (i >= W && mask[i - W] && !labels[i - W]) { labels[i - W] = label; stack[sp++] = i - W; }
        if (i < mask.length - W && mask[i + W] && !labels[i + W]) { labels[i + W] = label; stack[sp++] = i + W; }
      }
      comps.push({ label, area, labels });
    }
    return comps;
  }

  /** Turn a blob into a scored 4-corner candidate (or null). */
  function evaluate(comp, W, H) {
    const { label, labels, area } = comp;
    // Boundary points: left/right ends of each row, top/bottom ends of each column.
    // +/-1 compensates for the erosion step.
    const pts = [];
    let borderTouch = 0;
    for (let y = 0; y < H; y++) {
      let minX = -1, maxX = -1;
      for (let x = 0; x < W; x++) {
        if (labels[y * W + x] === label) { if (minX < 0) minX = x; maxX = x; }
      }
      if (minX >= 0) {
        pts.push({ x: minX - 1, y: y + 0.5 }, { x: maxX + 2, y: y + 0.5 });
        if (minX <= 1) borderTouch++;
        if (maxX >= W - 2) borderTouch++;
      }
    }
    for (let x = 0; x < W; x++) {
      let minY = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        if (labels[y * W + x] === label) { if (minY < 0) minY = y; maxY = y; }
      }
      if (minY >= 0) {
        pts.push({ x: x + 0.5, y: minY - 1 }, { x: x + 0.5, y: maxY + 2 });
        if (minY <= 1) borderTouch++;
        if (maxY >= H - 2) borderTouch++;
      }
    }
    const borderFrac = borderTouch / (2 * (W + H));
    if (borderFrac > 0.6) return null;   // this is the background around the page

    const hull = convexHull(pts);
    if (hull.length < 4) return null;
    let quad = reduceToQuad(hull);
    quad = refineWithLines(quad, pts);
    quad = orderCorners(quad);
    if (!isGoodQuad(quad)) return null;

    const qArea = polyArea(quad);
    const areaFrac = qArea / (W * H);
    const fill = (area + perimeter(quad)) / qArea;   // perimeter ≈ pixels lost to erosion
    if (areaFrac < 0.08 || areaFrac > 1.02 || fill < 0.8) return null;
    const score = areaFrac * Math.pow(Math.min(1, fill), 6) * (1 - borderFrac);
    return { quad, score };
  }

  /** Andrew's monotone chain convex hull. */
  function convexHull(points) {
    const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lower = [];
    for (const pt of p) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
      lower.push(pt);
    }
    const upper = [];
    for (let i = p.length - 1; i >= 0; i--) {
      const pt = p[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
      upper.push(pt);
    }
    upper.pop();
    lower.pop();
    return lower.concat(upper);
  }

  /** Repeatedly drop the hull corner whose removal loses the least area, until 4 remain. */
  function reduceToQuad(hull) {
    const pts = hull.slice();
    const triArea = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    while (pts.length > 4) {
      let minA = Infinity, minI = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = triArea(pts[(i - 1 + pts.length) % pts.length], pts[i], pts[(i + 1) % pts.length]);
        if (a < minA) { minA = a; minI = i; }
      }
      pts.splice(minI, 1);
    }
    return pts;
  }

  /** Fit a straight line to the boundary points along each side, then intersect neighbouring lines. */
  function refineWithLines(quad, pts) {
    const lines = [];
    for (let k = 0; k < 4; k++) {
      const a = quad[k], b = quad[(k + 1) % 4];
      const dx = b.x - a.x, dy = b.y - a.y;
      const L = Math.hypot(dx, dy);
      if (L < 4) return quad;
      const ux = dx / L, uy = dy / L;
      const tol = Math.max(1.5, L * 0.03);
      const sel = [];
      for (const p of pts) {
        const px = p.x - a.x, py = p.y - a.y;
        const t = (px * ux + py * uy) / L;
        const d = Math.abs(px * -uy + py * ux);
        if (t > 0.12 && t < 0.88 && d < tol) sel.push(p);
      }
      lines.push(sel.length >= 5 ? fitLine(sel) : { cx: a.x, cy: a.y, ex: ux, ey: uy });
    }
    const diag = Math.hypot(quad[2].x - quad[0].x, quad[2].y - quad[0].y) || 1;
    return quad.map((q, k) => {
      // Corner k is where side k-1 meets side k
      const p = intersect(lines[(k + 3) % 4], lines[k]);
      if (!p || Math.hypot(p.x - q.x, p.y - q.y) > diag * 0.12) return q;
      return p;
    });
  }

  function fitLine(pts) {
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    cx /= pts.length; cy /= pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) {
      const dx = p.x - cx, dy = p.y - cy;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { cx, cy, ex: Math.cos(angle), ey: Math.sin(angle) };
  }

  function intersect(l1, l2) {
    const det = l1.ex * (-l2.ey) - l1.ey * (-l2.ex);
    if (Math.abs(det) < 1e-6) return null;
    const bx = l2.cx - l1.cx, by = l2.cy - l1.cy;
    const s = (bx * (-l2.ey) - by * (-l2.ex)) / det;
    return { x: l1.cx + s * l1.ex, y: l1.cy + s * l1.ey };
  }

  /** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
  function orderCorners(pts) {
    const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
    const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
    const sorted = pts.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
    let start = 0;
    for (let i = 1; i < 4; i++) {
      if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
    }
    return [0, 1, 2, 3].map(i => sorted[(start + i) % 4]);
  }

  /** Convex, and every corner angle between 35° and 145°. */
  function isGoodQuad(q) {
    let sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
      const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
      const cr = v1x * v2y - v1y * v2x;
      const s = Math.sign(cr);
      if (!s || (sign && s !== sign)) return false;
      sign = s;
      const cos = (v1x * v2x + v1y * v2y) / (Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y) || 1);
      const deg = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
      if (deg < 35 || deg > 145) return false;
    }
    return true;
  }

  function polyArea(q) {
    let a = 0;
    for (let i = 0; i < q.length; i++) {
      const p = q[i], n = q[(i + 1) % q.length];
      a += p.x * n.y - n.x * p.y;
    }
    return Math.abs(a) / 2;
  }

  function perimeter(q) {
    let s = 0;
    for (let i = 0; i < q.length; i++) s += Math.hypot(q[(i + 1) % q.length].x - q[i].x, q[(i + 1) % q.length].y - q[i].y);
    return s;
  }

  /** Public helper for the crop editor: are these (pixel) corners a usable shape? */
  function cornersValid(corners) {
    const q = orderCorners(corners);
    return isGoodQuad(q);
  }

  // =========================================================
  // 2. Perspective flattening
  // =========================================================

  /** Solve the 8 numbers of the homography that maps (u,v) in `from` to (x,y) in `to`. */
  function homography(from, to) {
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const { x: u, y: v } = from[i], { x, y } = to[i];
      A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
      A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
    }
    // Gaussian elimination with partial pivoting
    for (let c = 0; c < 8; c++) {
      let piv = c;
      for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      [b[c], b[piv]] = [b[piv], b[c]];
      const d = A[c][c];
      if (Math.abs(d) < 1e-12) throw new Error('These corners can\'t be flattened. Spread them out a bit more.');
      for (let r = 0; r < 8; r++) {
        if (r === c) continue;
        const f = A[r][c] / d;
        if (!f) continue;
        for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
        b[r] -= f * b[c];
      }
    }
    return b.map((v, i) => v / A[i][i]);
  }

  /**
   * Flatten the page: `src` is a canvas, `corners` are TL,TR,BR,BL fractions.
   * Returns a new canvas with the page as a straight rectangle.
   */
  function warp(src, corners) {
    const sw = src.width, sh = src.height;
    const q = orderCorners(corners).map(p => ({ x: p.x * sw, y: p.y * sh }));
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    let H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const scale = Math.min(1, MAX_OUTPUT / Math.max(W, H));
    W = Math.max(16, Math.round(W * scale));
    H = Math.max(16, Math.round(H * scale));

    const h = homography(
      [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], q);

    const srcData = src.getContext('2d').getImageData(0, 0, sw, sh).data;
    const out = makeCanvas(W, H);
    const octx = out.getContext('2d');
    const img = octx.createImageData(W, H);
    const d = img.data;
    const maxX = sw - 1, maxY = sh - 1;
    let o = 0;
    for (let v = 0; v < H; v++) {
      const vv = v + 0.5;
      for (let u = 0; u < W; u++) {
        const uu = u + 0.5;
        const den = h[6] * uu + h[7] * vv + 1;
        let x = (h[0] * uu + h[1] * vv + h[2]) / den - 0.5;
        let y = (h[3] * uu + h[4] * vv + h[5]) / den - 0.5;
        if (x < 0) x = 0; else if (x > maxX) x = maxX;
        if (y < 0) y = 0; else if (y > maxY) y = maxY;
        const x0 = x | 0, y0 = y | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0, y1 = y0 < maxY ? y0 + 1 : y0;
        const fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        d[o] = srcData[i00] * w00 + srcData[i10] * w10 + srcData[i01] * w01 + srcData[i11] * w11;
        d[o + 1] = srcData[i00 + 1] * w00 + srcData[i10 + 1] * w10 + srcData[i01 + 1] * w01 + srcData[i11 + 1] * w11;
        d[o + 2] = srcData[i00 + 2] * w00 + srcData[i10 + 2] * w10 + srcData[i01 + 2] * w01 + srcData[i11 + 2] * w11;
        d[o + 3] = 255;
        o += 4;
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // =========================================================
  // 3. Filters
  // =========================================================

  /**
   * Estimate the paper colour everywhere on the page (the "background"),
   * so shadows and uneven light can be divided out.
   * Works on a coarse grid of blocks: each block takes the brightest
   * nearby block (text is ignored), then the grid is smoothed.
   */
  function backgroundGrid(d, W, H) {
    const B = Math.max(8, Math.round(Math.max(W, H) / 60));
    const gw = Math.ceil(W / B), gh = Math.ceil(H / B);
    const mean = new Float32Array(gw * gh * 3);
    const lum = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let r = 0, g = 0, b = 0, n = 0;
        const yEnd = Math.min(H, (gy + 1) * B), xEnd = Math.min(W, (gx + 1) * B);
        for (let y = gy * B; y < yEnd; y += 2) {
          for (let x = gx * B; x < xEnd; x += 2) {
            const i = (y * W + x) * 4;
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
          }
        }
        const k = gy * gw + gx;
        mean[k * 3] = r / n; mean[k * 3 + 1] = g / n; mean[k * 3 + 2] = b / n;
        lum[k] = 0.299 * r / n + 0.587 * g / n + 0.114 * b / n;
      }
    }
    // Dilate: each block takes the colour of the brightest block within 2 blocks
    const dil = new Float32Array(gw * gh * 3);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        let best = -1, bk = 0;
        for (let yy = Math.max(0, gy - 2); yy <= Math.min(gh - 1, gy + 2); yy++) {
          for (let xx = Math.max(0, gx - 2); xx <= Math.min(gw - 1, gx + 2); xx++) {
            const k = yy * gw + xx;
            if (lum[k] > best) { best = lum[k]; bk = k; }
          }
        }
        const k = gy * gw + gx;
        dil[k * 3] = mean[bk * 3]; dil[k * 3 + 1] = mean[bk * 3 + 1]; dil[k * 3 + 2] = mean[bk * 3 + 2];
      }
    }
    // Smooth (3×3 average, twice)
    let g = dil;
    for (let pass = 0; pass < 2; pass++) {
      const s = new Float32Array(g.length);
      for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
          let r = 0, gg = 0, b = 0, n = 0;
          for (let yy = Math.max(0, gy - 1); yy <= Math.min(gh - 1, gy + 1); yy++) {
            for (let xx = Math.max(0, gx - 1); xx <= Math.min(gw - 1, gx + 1); xx++) {
              const k = (yy * gw + xx) * 3;
              r += g[k]; gg += g[k + 1]; b += g[k + 2]; n++;
            }
          }
          const k = (gy * gw + gx) * 3;
          s[k] = r / n; s[k + 1] = gg / n; s[k + 2] = b / n;
        }
      }
      g = s;
    }
    return { grid: g, gw, gh, B };
  }

  /**
   * Apply a look to a canvas. Returns a NEW canvas (the input is not changed).
   * original – as photographed (just flattened)
   * color    – shadows removed, paper made white, colours kept
   * grey     – same, in greyscale
   * bw       – crisp black text on white paper
   */
  function applyFilter(src, filter) {
    const W = src.width, H = src.height;
    const out = makeCanvas(W, H);
    const octx = out.getContext('2d');
    octx.drawImage(src, 0, 0);
    if (filter === 'original') return out;

    const img = octx.getImageData(0, 0, W, H);
    const d = img.data;
    const { grid, gw, gh, B } = backgroundGrid(d, W, H);

    // Levels curve for colour/grey: pure white paper, slightly deeper ink
    const lut = new Uint8ClampedArray(512);
    for (let i = 0; i < 512; i++) {
      const v = i / 400;                       // ratio pixel/paper, 0 … 1.28
      let t = (v - 0.1) / (0.88 - 0.1);
      t = Math.max(0, Math.min(1, t));
      lut[i] = Math.round(Math.pow(t, 1.3) * 255);
    }

    for (let y = 0; y < H; y++) {
      // Bilinear position in the background grid (block centres)
      let fy = (y + 0.5) / B - 0.5;
      if (fy < 0) fy = 0; else if (fy > gh - 1) fy = gh - 1;
      const gy0 = fy | 0, gy1 = Math.min(gh - 1, gy0 + 1), ty = fy - gy0;
      for (let x = 0; x < W; x++) {
        let fx = (x + 0.5) / B - 0.5;
        if (fx < 0) fx = 0; else if (fx > gw - 1) fx = gw - 1;
        const gx0 = fx | 0, gx1 = Math.min(gw - 1, gx0 + 1), tx = fx - gx0;
        const k00 = (gy0 * gw + gx0) * 3, k10 = (gy0 * gw + gx1) * 3;
        const k01 = (gy1 * gw + gx0) * 3, k11 = (gy1 * gw + gx1) * 3;
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
        const br = grid[k00] * w00 + grid[k10] * w10 + grid[k01] * w01 + grid[k11] * w11 + 1;
        const bg = grid[k00 + 1] * w00 + grid[k10 + 1] * w10 + grid[k01 + 1] * w01 + grid[k11 + 1] * w11 + 1;
        const bb = grid[k00 + 2] * w00 + grid[k10 + 2] * w10 + grid[k01 + 2] * w01 + grid[k11 + 2] * w11 + 1;
        const i = (y * W + x) * 4;

        if (filter === 'color') {
          d[i] = lut[Math.min(511, (d[i] / br * 400) | 0)];
          d[i + 1] = lut[Math.min(511, (d[i + 1] / bg * 400) | 0)];
          d[i + 2] = lut[Math.min(511, (d[i + 2] / bb * 400) | 0)];
        } else {
          const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
          const bl = 0.299 * br + 0.587 * bg + 0.114 * bb;
          const ratio = lum / bl;
          let v;
          if (filter === 'bw') {
            // Soft threshold: below 0.70 of paper brightness = black, above 0.84 = white
            const t = (ratio - 0.70) / 0.14;
            v = t <= 0 ? 0 : t >= 1 ? 255 : Math.round(t * 255);
          } else {
            v = lut[Math.min(511, (ratio * 400) | 0)];
          }
          d[i] = d[i + 1] = d[i + 2] = v;
        }
      }
    }
    octx.putImageData(img, 0, 0);
    return out;
  }

  // =========================================================
  // 4. Rotation, thumbnails, full pipeline
  // =========================================================

  /** Rotate a canvas clockwise by 0/90/180/270 degrees. Returns a new canvas (or the same one for 0). */
  function rotate(src, degrees) {
    const deg = ((degrees % 360) + 360) % 360;
    if (!deg) return src;
    const swap = deg === 90 || deg === 270;
    const out = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
    const ctx = out.getContext('2d');
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src, -src.width / 2, -src.height / 2);
    return out;
  }

  function thumbnail(canvas) {
    const t = drawToCanvas(canvas, canvas.width, canvas.height, THUMB_MAX);
    const url = t.toDataURL('image/jpeg', 0.72);
    Utils.freeCanvas(t);
    return url;
  }

  /** Photo/frame → capped JPEG Blob (the "original" kept for re-cropping) + its canvas. */
  async function captureOriginal(source, sw, sh) {
    const canvas = drawToCanvas(source, sw, sh, MAX_ORIGINAL);
    const blob = await Utils.canvasToBlob(canvas, 'image/jpeg', 0.9);
    return { canvas, blob };
  }

  /** Load a stored original Blob into a canvas. */
  async function originalCanvas(blob) {
    const img = await Utils.blobToImage(blob);
    return drawToCanvas(img, img.naturalWidth, img.naturalHeight, MAX_ORIGINAL);
  }

  /**
   * Finish a flattened page: apply filter + rotation and encode.
   * Returns { blob, thumb, width, height }. `flat` is not modified.
   */
  async function finish(flat, filter, rotation) {
    const filtered = applyFilter(flat, filter);
    const rotated = rotate(filtered, rotation || 0);
    const blob = await Utils.canvasToBlob(rotated, 'image/jpeg', OUTPUT_QUALITY);
    const result = { blob, thumb: thumbnail(rotated), width: rotated.width, height: rotated.height };
    if (rotated !== filtered) Utils.freeCanvas(rotated);
    Utils.freeCanvas(filtered);
    return result;
  }

  /** Full pipeline from an original canvas: flatten → filter → rotate → encode. */
  async function processPage(srcCanvas, { corners, filter, rotation }) {
    const flat = warp(srcCanvas, corners);
    try {
      return await finish(flat, filter, rotation);
    } finally {
      Utils.freeCanvas(flat);
    }
  }

  return {
    FILTERS, MAX_ORIGINAL,
    detectQuad, fullFrameCorners, orderCorners, cornersValid,
    drawToCanvas, captureOriginal, originalCanvas,
    warp, applyFilter, rotate, finish, processPage, thumbnail
  };
})();
