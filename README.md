# SnapShot Studio

A Manifest V3 Chrome extension for **screenshots, screen recording, OCR, QR
decoding, annotation, and PDF signing** — inspired by Shottr and GoFullPage.

Cross-platform by design (Windows / macOS / Linux): Chrome is the runtime, so
there is **no native code**. Everything runs **fully offline** — OCR, QR, and
all PDF work use libraries vendored under `vendor/`.

---

## Features

**Capture**
- Visible tab, drag-to-select area, and full-page scroll-and-stitch — no share
  picker (`chrome.tabs.captureVisibleTab`).
- Full screen and active window via `chrome.desktopCapture` (Chrome's share
  picker is shown — a privacy rule that cannot be bypassed).
- Delayed shot: 3 / 5 / 10 s.

**Record**
- Screen recording → WebM, with optional microphone and tab/system audio.
- Start/stop from the popup or a keyboard shortcut; a red badge shows while live.

**Editor** (Konva canvas, opens in a tab)
- Crop, and annotate: arrow, rectangle, oval, freehand, highlighter, text, step
  counter, spotlight, and blur/pixelate (incl. OCR-guided text-only blur).
- Backgrounds: solid/gradient fill, drop shadow, rounded corners, padding.
- Export PNG / JPEG / multi-page PDF, copy to clipboard, optional S3 upload.

**OCR & QR** (offline)
- Text extraction via Tesseract.js (WASM); QR/barcode via `BarcodeDetector`
  with a jsQR fallback.

**PDF editor & signing**
- Open a PDF (or drop one in), navigate pages, and add a **signature** to any
  spot — draw it, type it, or upload an image, then drag and resize.
- **Pen** and **highlighter** for marking up while you read, plus text and a
  date stamp; marks are kept per page.
- Save with pdf-lib: annotations overlay the **original** pages (underlying text
  is preserved, not flattened), exported as `<name>-signed.pdf`.

---

## Install (load unpacked)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder (the one with `manifest.json`).
3. Pin **SnapShot Studio** and open it from the toolbar.

No build step — plain JavaScript. Requires **Chrome 116+** (offscreen documents).

## Keyboard shortcuts

| Action | Windows / Linux | macOS |
|---|---|---|
| Full-page capture | `Ctrl+Shift+E` | `⌘+Shift+E` |
| Area capture | `Ctrl+Shift+S` | `⌘+Shift+S` |
| Full-screen capture / Start–stop recording | set at `chrome://extensions/shortcuts` | |

Shortcuts fire only while Chrome is focused — they are not system-wide.

---

## Architecture (MV3)

```
manifest.json
src/
  lib/        Shared, dependency-free utilities + a device profiler
  popup/      Toolbar UI
  background/ Service worker: routing, shortcuts, timers, offscreen, stream IDs
  offscreen/  Media work: getUserMedia frame grabs + MediaRecorder
  content/    In-page area overlay + full-page scroll & stitch
  editor/     Konva editor: crop, annotate, OCR, QR, export
  pdf/        PDF editor: open, sign, pen/highlight, save (pdf.js + pdf-lib)
vendor/       konva, jspdf, jsqr, tesseract, pdfjs, pdf-lib (all offline)
test/         Unit tests (Node built-in runner)
e2e/          Playwright end-to-end tests (real extension in Chromium)
```

**Performance across devices:** `deviceProfile()` (in `src/lib/utils.js`) reads
`hardwareConcurrency`, `deviceMemory`, and Save-Data to adapt work — capped
stitch height and pixel ratio on low-power devices, adaptive scroll pacing,
single-threaded OCR, and rAF-coalesced editor redraws.

**Constraints handled:** desktop-capture picker is mandatory;
`captureVisibleTab` rate limit (~2/s) is spaced between full-page slices;
fixed/sticky headers are hidden after the first slice; lazy images get a pause
per scroll step; full-page height is capped under the ~32,767 px canvas limit;
recording output is WebM (MP4 would need ffmpeg.wasm); DRM content can't be
captured.

---

## Development

```bash
npm ci

npm test          # unit tests (no browser)
npm run test:e2e  # end-to-end (real extension in Chromium, headed under Xvfb)
npm run test:all  # both
```

Local checkout, e.g. under `~/Documents/GitHub`:

```bash
cd ~/Documents/GitHub
git clone https://github.com/bronglil/Chrome-extension.git
cd Chrome-extension
npm ci
```

### Tests

- **Unit — `test/` (20):** the reusable core in `src/lib/utils.js` — `clampRect`,
  `throttle`, `rafDebounce`, `loadImage`, `blobToDataUrl`, and `deviceProfile()`.
- **E2E — `e2e/` (26, Playwright):** load the real unpacked extension and drive
  it — popup, editor annotations/export, `captureVisibleTab`, full-page
  scroll-and-stitch, area select, offline OCR & QR, and the PDF editor
  (open, page nav, pen, highlighter, signature, signed-PDF export).

> MV3 extensions load only in **headed** Chromium, so E2E runs under **Xvfb**.
> The fixture picks the pre-installed browser, or Playwright's own if none —
> override with `CHROMIUM_PATH`. Desktop-picker flows can't be scripted (browser
> privacy control) and are validated manually.

### CI & versioning

- **CI** (`.github/workflows/ci.yml`) runs on every push and PR: unit tests, a
  version-sync check, then the full E2E suite on Chromium under Xvfb.
- **Release** (`.github/workflows/release.yml`): when the version changes on
  `master`, it tags `vX.Y.Z` and publishes a GitHub Release with a zipped
  unpacked extension.
- `package.json` and `manifest.json` versions are kept in lock-step —
  `npm version <patch|minor|major>` bumps both (`npm run version:check` /
  `version:sync` verify or sync them).

---

## Tech stack

Manifest V3 · vanilla JS (no build step) · Konva.js (canvas) · Tesseract.js
(OCR) · jsPDF (PDF export) · jsQR + `BarcodeDetector` (codes) · pdf.js + pdf-lib
(PDF signing). All vendored for offline use.

## Third-party licenses

Konva (MIT), jsPDF (MIT), jsQR (Apache-2.0), Tesseract.js (Apache-2.0) and its
`eng` data (Apache-2.0), pdf.js (Apache-2.0), pdf-lib (MIT) are redistributed
under their respective licenses in `vendor/`.
