/* =========================================================
   service-worker.js – makes the app work offline.

   Strategy: "precache + cache-first" for the app's own files.
   On install, every file the app needs (HTML, CSS, JS, jsPDF,
   icons) is downloaded into a cache. After that, the app loads
   from the cache, with or without internet.

   Scans are NOT handled here – they live in IndexedDB.

   >>> WHEN YOU CHANGE ANY APP FILE AND RE-UPLOAD IT, increase
   >>> CACHE_VERSION below (e.g. 'v1.0.1') and APP_VERSION in
   >>> js/app.js. That is how phones learn there is a new version.
   >>> The app will then show an "Update" banner.
   >>> Upload THIS file LAST, after all the other changed files,
   >>> so a phone never fetches the new version half-uploaded.
   ========================================================= */

const CACHE_VERSION = 'v1.1.0';
const CACHE_NAME = 'scanner-' + CACHE_VERSION;

// The OCR files (~7 MB) are kept in their own cache that does NOT change with
// CACHE_VERSION, so app updates don't download them again. Only change this
// name if you replace the files in js/lib/ocr with a different Tesseract version.
const OCR_CACHE = 'scanner-ocr-5.1.1';
const OCR_FILES = [
  './js/lib/ocr/worker.min.js',
  './js/lib/ocr/tesseract-core-simd-lstm.wasm.js',
  './js/lib/ocr/eng.traineddata.gz'
  // tesseract-core-lstm.wasm.js (older phones only) is cached the first time it's used
];

// The app page is cached as './' (not './index.html'): some hosts, such as
// Cloudflare Pages, redirect /index.html to /, and Safari refuses to show a
// page that a service worker serves from a redirected response.
const APP_FILES = [
  './',
  './manifest.json',
  './css/styles.css',
  './js/lib/jspdf.umd.min.js',
  './js/lib/ocr/tesseract.min.js',
  './js/ocr.js',
  './js/utils.js',
  './js/db.js',
  './js/settings.js',
  './js/imaging.js',
  './js/crop.js',
  './js/camera.js',
  './js/pdf.js',
  './js/docs.js',
  './js/app.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png'
];

/**
 * If the server answered via a redirect, copy the response into a fresh
 * one without the "redirected" flag (Safari rejects flagged responses).
 */
async function cleanResponse(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

// Download all app files. If any file fails, installation fails and the
// previous working version stays in charge (no half-installed app).
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    for (const url of APP_FILES) {
      const res = await fetch(new Request(url, { cache: 'reload' }));
      if (!res.ok) throw new Error('Could not download ' + url + ' (' + res.status + ')');
      await cache.put(url, await cleanResponse(res));
    }
    // OCR files: only download what isn't cached yet. Best effort – if this fails
    // (e.g. weak signal), the app still installs and OCR fetches them when first used.
    try {
      const ocr = await caches.open(OCR_CACHE);
      for (const url of OCR_FILES) {
        if (await ocr.match(url)) continue;
        const res = await fetch(url);
        if (res.ok) await ocr.put(url, await cleanResponse(res));
      }
    } catch (e) { /* see above */ }
  })());
  // Do not skipWaiting automatically: the page asks the user first (see app.js).
});

// Remove caches from older versions.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('scanner-') && k !== CACHE_NAME && k !== OCR_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// The page sends this when the user taps "Update".
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

// When testing on your own PC (localhost), always try the network first so
// code edits show up on refresh; the cache is still used if the server is off.
const IS_LOCAL_DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // only our own files

  // OCR files: cache first, and keep anything fetched (e.g. the older-phone engine)
  if (url.pathname.includes('/js/lib/ocr/') && !url.pathname.endsWith('tesseract.min.js')) {
    event.respondWith((async () => {
      const cache = await caches.open(OCR_CACHE);
      const cached = await cache.match(req, { ignoreSearch: true });
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok && !res.redirected) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  if (IS_LOCAL_DEV) {
    event.respondWith(
      fetch(req).then(res => {
        if (res.ok && !res.redirected && APP_FILES.includes('./' + url.pathname.replace(/^\//, ''))) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match(req.mode === 'navigate' ? './' : req, { ignoreSearch: true }))
    );
    return;
  }

  // Opening the app (any page navigation) -> serve the cached app page
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./', { cacheName: CACHE_NAME });
      if (cached && !cached.redirected) return cached;
      return cleanResponse(await fetch(req));
    })());
    return;
  }

  // App files -> cache first, network as a fallback
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(cached => cached || fetch(req))
  );
});
