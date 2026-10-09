# Scanner – offline document scanner PWA (Version 1)

Scan paper pages with the iPhone camera, flatten and clean them up, and combine them into a named PDF
you can save to Files or share. Scans are stored only on the device (IndexedDB).
There is no backend, no accounts and nothing that costs money. Built the same way as the Site Inspections (SnagApp) app.

## What it does

- **Live camera** with the page outlined as you aim (automatic edge detection)
- **Flashlight button** that stays on while scanning, plus a "Low light – turn on the flashlight" tip
- **Auto-capture**: hold steady over a page and it takes the photo, then waits for the next page
- **Corner editor**: drag the corners (with a magnifier) or whole edges; "Use whole photo" if needed
- **Looks**: Original, Colour (shadows removed, paper made white), Grey, B&W (crisp text)
- **Library** of scans: rename, add pages (camera or Photos), reorder, rotate, re-crop, delete
- **Save PDF**: choose the file name and page size (A4, US Letter, or Fit to scan) → Share / Save to Files

## Folder structure

```
ScanApp/
├── index.html              App shell (loads everything)
├── manifest.json           PWA install settings (name, colours, icons)
├── service-worker.js       Offline caching of the app files  ← bump CACHE_VERSION on every update
├── serve.ps1               Local test server for Windows (not needed online)
├── README.md               This file
├── css/styles.css
├── icons/                  icon-192.png, icon-512.png, apple-touch-icon.png (180×180)
└── js/
    ├── lib/jspdf.umd.min.js   jsPDF 2.5.1 (MIT licence) – PDF generation, stored locally for offline use
    ├── utils.js            Dates, file names, dialogs, file sharing
    ├── db.js               IndexedDB database (scans, pages, page images, settings)
    ├── settings.js         Settings screen
    ├── imaging.js          Page detection, perspective flattening, filters (no libraries)
    ├── crop.js             Full-screen corner editor
    ├── camera.js           Live camera, flashlight, auto-capture
    ├── pdf.js              PDF creation and "Save as PDF" dialog
    ├── docs.js             Home, scan and page screens; adding pages
    └── app.js              Router, start-up, service worker registration
```

## 1. Run it locally (Windows)

1. Open the `ScanApp` folder in File Explorer, click the address bar, type `powershell`, press Enter.
2. Run:
   ```
   powershell -ExecutionPolicy Bypass -File serve.ps1 -Port 8081
   ```
3. Open **http://localhost:8081** in Chrome or Edge. (Port 8081 so it doesn't clash with SnagApp on 8080.)
4. `Ctrl+C` stops the server.

Your PC's webcam works for testing the live camera in Chrome. Press `F12` → phone icon to see the phone layout.
The flashlight button only appears on devices that support it, so you won't see it on a PC.

## 2. Host it for free on GitHub Pages

Same steps as SnagApp:

1. https://github.com → **+** → **New repository** → name `scanner`, **Public**, no README → **Create repository**.
2. Click **"uploading an existing file"**, drag **everything inside** the `ScanApp` folder onto the page
   (but not the hidden `.claude` folder, which isn't needed), and click **Commit changes**.
3. Check `index.html` is at the top level of the repository.
4. **Settings** → **Pages** → Source **Deploy from a branch**, Branch **main** / **(root)** → **Save**.
5. After 1–3 minutes your app is at **`https://<your-username>.github.io/scanner/`**

The camera only works over **https** (or localhost), which GitHub Pages provides.

### Updating the app later

1. Edit and test locally.
2. Increase `CACHE_VERSION` in `service-worker.js` (e.g. `'v1.0.0'` → `'v1.0.1'`) and `APP_VERSION` in `js/app.js` to match.
3. Upload the changed files to GitHub (into the matching folders), uploading `service-worker.js` **last**.
4. Open the app online. An **Update** banner appears; tap it.

## 3. Install on the iPhone

1. In **Safari**, open `https://<your-username>.github.io/scanner/`.
2. **Share** → **Add to Home Screen** → name it "Scanner" → **Add**.
3. Open it from the Home Screen icon once while online (this caches it for offline use).
4. Tap **Scan** and allow camera access.

Always use the Home Screen icon. The installed app and a Safari tab have **separate storage**.

## How to scan

1. **Scan** → aim at the page. A blue outline appears when the page is found.
2. Low light? Tap the **⚡ flashlight** button (or the yellow tip). It stays on until you leave the camera.
3. Tap the **shutter** (or turn on **AUTO** and hold steady; it turns green, then captures).
4. Check the corners → **Keep scan**. Next page… → **Done**.
5. On the scan screen: tap the name to rename it, tap a page to change its look, rotate it or re-crop it.
6. **Save PDF** → edit the file name, choose page size → **Create PDF** → **Share / Save** → *Save to Files*.

Tips for good detection: put the page on a **darker or contrasting surface** (wood desk, dark table)
with the whole page in view. White paper on a white desk is hard to detect. Just drag the corners.

## iPhone limitations (know these)

1. **Flashlight control needs a recent iOS** (web-app torch support arrived around iOS 17.4–18). The app checks
   whether the phone supports it: if not, the button is hidden and the tip suggests moving somewhere brighter.
2. **Camera permission:** Home Screen apps may ask for camera access again after being closed. That's an iOS rule.
   If you tapped "Don't Allow", the app offers the regular iPhone camera instead (Take Photo), which always works.
3. **Storage is per device.** Deleting the Home Screen icon deletes your scans. Save PDFs you want to keep to Files.
4. **Saving files** goes through the Share sheet → *Save to Files*. There is no silent download to a folder.
5. **Updates** only arrive when the app is opened online.

## Design decisions

- **No big libraries.** Page detection is hand-written (brightness/colour threshold → largest page-shaped blob →
  straight-line fit to each edge), ~10–90 ms per frame, instead of the 8 MB OpenCV.js.
- **Each page keeps the original photo** (≤ 2800 px) so it can be re-cropped later, plus the finished page
  (≤ 2200 px tall ≈ 190 dpi on A4, JPEG 82%) which goes into the PDF unchanged. Typically 100–600 KB per page.
- **Colour/Grey/B&W** estimate the paper colour across the page and divide it out, which removes shadows and
  uneven light, then deepen the ink.
- **Auto-capture** won't capture the same page twice; it waits until the page leaves view or moves.
- **Safety:** adding/removing a page updates the scan in one database transaction.

## Testing checklist

- [ ] Scan → camera opens, outline follows the page
- [ ] Flashlight on / off; stays on between pages
- [ ] Low-light tip appears in a dark room
- [ ] Shutter → corner editor → drag a corner (magnifier shows) → Keep scan
- [ ] Retake discards the photo
- [ ] AUTO: hold steady → captures once → "Got it – show the next page"
- [ ] Photos button imports one or several photos
- [ ] Done → scan screen shows all pages
- [ ] Rename scan
- [ ] Page: Original / Colour / Grey / B&W
- [ ] Page: rotate left/right, Crop (re-crop), Move earlier/later, Delete
- [ ] Reorder on the scan screen
- [ ] Save PDF with a custom name → A4 / Letter / Fit → Share / Save → Save to Files
- [ ] Open the PDF in Files: page order, rotation, sharpness
- [ ] Delete a scan
- [ ] Airplane Mode → app opens and scans offline, PDF works offline
- [ ] Update banner after bumping CACHE_VERSION
