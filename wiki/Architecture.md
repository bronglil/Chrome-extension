# Architecture (MV3)

```
manifest.json
src/
  lib/        Shared, dependency-free utilities + a device profiler
  popup/      Toolbar UI (+ page-URL QR share panel)
  background/ Service worker: routing, shortcuts, timers, offscreen, stream IDs
  offscreen/  Media work: getUserMedia frame grabs + MediaRecorder
  content/    In-page area overlay + full-page scroll & stitch
  editor/     Konva editor: crop, annotate, OCR, QR, export
  pdf/        PDF editor: open, sign, pen/highlight, save (pdf.js + pdf-lib)
vendor/       konva, jspdf, jsqr, tesseract, pdfjs, pdf-lib, qrcode (offline)
```

## Why these boundaries (MV3 constraints)
- **Service workers can't touch the DOM or media**, so all media work is
  delegated: `chrome.tabs.captureVisibleTab` (web capture), `chrome.desktopCapture`
  (screen/window stream IDs), an **offscreen document** (frame grabs +
  `MediaRecorder`), and a **content script** (overlay + scroll-and-stitch).
- Captured images are stashed in `chrome.storage.local` under a short id; the
  editor tab reads them back by id (avoids giant message payloads).

## Message flow
`popup / shortcut → service worker → (content script or offscreen document) →
capture → chrome.storage.local → editor tab`

## Performance across devices
`deviceProfile()` in `src/lib/utils.js` reads `hardwareConcurrency`,
`deviceMemory`, and Save-Data to adapt work: capped stitch height and raster
pixel ratio on low-power devices, adaptive full-page scroll pacing, and
rAF-coalesced editor redraws.

## Notable fixes worth knowing
- The extension **won't load at all** if the CSP contains `worker-src blob:`
  (it hangs Chrome's load). Keep CSP to `script-src 'self' 'wasm-unsafe-eval'`.
- Tesseract must use `workerBlobURL: false` (blob workers are blocked by the
  extension CSP), and the **LSTM core** files must be vendored for OCR to work.
- A class with `display: flex/grid` beats the `[hidden]` attribute — modals and
  panels need an explicit `.x[hidden] { display: none }` rule.

## Why vanilla JS (no framework)
No build step, tiny/instant popup, MV3-CSP-friendly, and the heavy lifting is in
specialized libs (Konva, pdf.js/pdf-lib, Tesseract). If complexity grows, adopt
**TypeScript** first — not a UI framework.
