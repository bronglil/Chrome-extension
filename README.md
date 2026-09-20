# 📸 SnapShot Studio — Screenshot & Screen Recorder (Chrome MV3)

A cross-platform (Windows + macOS + Linux) Chrome extension for screenshots,
full-page capture, screen recording, OCR, QR decoding and annotation — inspired
by **Shottr** and **GoFullPage**. It is cross-platform automatically: Chrome is
the runtime, so there is **no native code**.

Everything runs **fully offline** — OCR (Tesseract.js WASM), QR decode and PDF
export are all vendored locally under `vendor/`.

---

## ✨ Features

### Capture
| Mode | How | Picker? |
|------|-----|---------|
| Visible area | `chrome.tabs.captureVisibleTab` | No |
| Selected area | In-page drag overlay → crop | No |
| Full page | Scroll & stitch onto one tall canvas | No |
| Full screen | `chrome.desktopCapture` → frame grab | Yes (Chrome privacy rule) |
| Active window | `chrome.desktopCapture(['window'])` → frame | Yes |
| Delayed shot | 3 / 5 / 10 s timer, then capture | — |

### Recording
- Screen recording via `getUserMedia`(desktop stream) → **MediaRecorder** in the
  offscreen document → **WebM** blob, saved to Downloads.
- Optional **microphone** and **tab/system audio**.
- Start/stop from the popup or the keyboard shortcut. A red badge shows while recording.

### Editor (opens in a full browser tab, Konva.js canvas)
- **Crop** & resize.
- **Annotate:** arrow, rectangle, oval, freehand, highlighter, text, step counter,
  spotlight, and **blur/pixelate** (including an OCR-guided **text-only blur** mode).
- **Backgrounds:** solid/gradient fill, drop shadow, rounded corners, padding.

### OCR & QR
- **OCR** via Tesseract.js (WASM, offline) — extract text from the capture and copy
  it to the clipboard.
- **QR/barcode** decode via the native `BarcodeDetector` API, falling back to **jsQR**.

### Export
- **PNG** and **JPEG**.
- **PDF** via jsPDF — long/full-page images are split across multiple pages.
- **Copy to clipboard** and **Save to Downloads**.
- Optional **upload** to an S3-compatible bucket (paste a presigned PUT URL) — the
  resulting link is copied to your clipboard.

---

## 🧩 Architecture (Manifest V3)

```
manifest.json
src/
  lib/            Shared, dependency-free utilities (throttle, rAF-debounce,
                  image/blob helpers, and a device profiler) reused by every
                  context — popup, content, offscreen and editor
  popup/          Toolbar UI — one button per capture mode
  background/     Service worker: routing, shortcuts, delay timers,
                  creates the offscreen document, supplies stream IDs
  offscreen/      ALL media work: getUserMedia frame grabs, MediaRecorder
                  (MV3 service workers can't touch the DOM or media)
  content/        In-page area-selection overlay + full-page scroll & stitch
  editor/         Konva canvas editor: crop, annotate, OCR, QR, export
vendor/           konva, jspdf, jsqr, tesseract (core wasm + eng lang data)
icons/
test/             Unit tests for src/lib/utils.js (Node built-in runner)
e2e/              Playwright end-to-end tests (real extension in Chromium)
```

**Message flow:** popup / shortcut → service worker → (content script *or*
offscreen document) → capture → stashed in `chrome.storage.local` → editor tab.

---

## 🚀 Install (Load unpacked)

1. Open **`chrome://extensions`**.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one containing
   `manifest.json`).
4. Pin **SnapShot Studio** to the toolbar and click it.

No build step is required — this is plain JavaScript. (If you fork it to
TypeScript, use Vite; keep dependencies minimal.)

Requires **Chrome 116+** (offscreen documents + `chrome.runtime.getContexts`).

---

## ⌨️ Keyboard shortcuts (`chrome.commands`)

| Action | Default (Win/Linux) | macOS |
|--------|--------------------|-------|
| Full-page capture | `Ctrl+Shift+E` | `⌘+Shift+E` |
| Area capture | `Ctrl+Shift+S` | `⌘+Shift+S` |
| Full-screen capture | *(set in `chrome://extensions/shortcuts`)* | |
| Start/stop recording | *(set in `chrome://extensions/shortcuts`)* | |

> Shortcuts only fire while **Chrome is the focused app** — they are not
> system-wide. Rebind them at `chrome://extensions/shortcuts`.

---

## 📖 Usage

- **Web-page shots** (visible / area / full page) never show a share picker.
- **Desktop shots** (full screen / active window / recording) always show
  Chrome's *"choose what to share"* picker — this is a browser privacy rule and
  **cannot be bypassed**.
- After a capture the **editor tab** opens. Annotate, then export via the top bar
  (Copy / PNG / JPG / PDF / Upload) or run **OCR** / **QR**.
- The blank editor also accepts **drag-and-dropped images**.

---

## ⚠️ Constraints handled

- **Share picker** is mandatory for screen/window capture (privacy); only tab
  capture can skip it after a user gesture.
- **`captureVisibleTab` rate limit** (~2 calls/sec): the full-page routine adds a
  delay between slices so captures don't fail silently.
- **Fixed/sticky headers** are hidden after the first full-page slice, then
  restored, to avoid duplicated banners.
- **Lazy-loaded images**: the scroller pauses after each step so images load.
- **Max canvas ~32,767px**: full-page height is capped under that limit.
- **Recording output is WebM** — MP4 would need `ffmpeg.wasm` transcoding (left
  out on purpose).
- **DRM-protected content cannot be captured** (browser restriction).

### Performance across devices

A shared **device profiler** (`src/lib/utils.js` → `deviceProfile()`) reads
`hardwareConcurrency`, `deviceMemory` and the Network Information API to adapt
work to the machine:

- **Low-power devices** (≤2 cores/GB or Save-Data/2G) get longer full-page
  scroll settle times and a lower stitched-canvas cap (16k vs 32k px).
- Raster **pixel ratio is capped** (1× on low-power, 2× otherwise) so 3–4×
  displays don't exhaust memory.
- Slider-driven **background relayout is coalesced to one redraw per animation
  frame** (`rafDebounce`) for smooth editing everywhere.
- OCR runs single-threaded on constrained devices.

---

## ✅ Tests

Two layers, both fully automated:

```bash
npm test        # unit tests  (Node built-in runner, no browser)
npm run test:e2e   # end-to-end (real extension in Chromium via Playwright)
npm run test:all   # both
```

### Unit tests — `test/` (20 tests)
Cover the reusable core in `src/lib/utils.js`: `clampRect`, `throttle`,
`rafDebounce`, `sleep`, `loadImage`, `blobToDataUrl` and the device-adaptive
`deviceProfile()` (high-end vs 2-core vs Save-Data/2G, and missing-hint
fallbacks). Browser globals are stubbed in `test/env.js` via an isolated VM
sandbox. No dependencies to install.

### End-to-end tests — `e2e/` (19 tests, Playwright)
Load the **real unpacked extension** into Chromium and drive it:

| Spec | Covers |
|------|--------|
| `00-smoke` | Extension loads, service worker registers |
| `01-popup` | Every capture-mode button + recording controls render |
| `02-editor-annotate` | Konva stage, rectangle/arrow/oval/step tools, undo, gradient+padding background |
| `03-export` | PNG / JPEG / clipboard / multi-page PDF export |
| `04-capture` | `captureVisibleTab`, **full-page scroll-and-stitch**, area-selection drag (real content script on a served page) |
| `05-ocr-qr` | Offline **Tesseract OCR** extracts text; **QR decode** returns the value |

E2E notes:
- MV3 extensions only load in **headed** Chromium, so `test:e2e` runs under
  **Xvfb** (`xvfb-run`). The fixture points at the pre-installed Chromium via
  `CHROMIUM_PATH` (defaults to the container path; override with the env var).
- Desktop-picker flows (`getDisplayMedia` / `desktopCapture`) can't be scripted
  headlessly — the picker is a browser privacy control — so those paths are
  driven through the pieces that don't need a picker (tab capture, editor,
  OCR/QR), which exercise the same logic.

> These E2E tests caught two real load-time bugs during development: a
> `worker-src blob:` CSP directive that hung the entire extension load, and
> missing Tesseract LSTM core files that broke OCR. Both are fixed.

## 🛠️ Tech stack

Manifest V3 · vanilla JS (no build step) · **Konva.js** (editor canvas) ·
**Tesseract.js** (offline OCR) · **jsPDF** (PDF export) · **jsQR** +
`BarcodeDetector` (codes). All vendored in `vendor/` for offline use.

## 📦 Third-party licenses

Konva (MIT), jsPDF (MIT), jsQR (Apache-2.0), Tesseract.js (Apache-2.0) and the
`eng` trained data (Apache-2.0) are redistributed under their respective
licenses in `vendor/`.
