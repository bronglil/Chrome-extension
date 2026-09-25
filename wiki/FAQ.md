# FAQ

**Why is the "choose what to share" picker always shown for screen/window?**
It's a Chrome privacy rule. Only tab capture (`captureVisibleTab`) can skip a
picker after a user gesture; screen/window/desktop capture always prompts.

**Is my data sent anywhere?**
No. Everything — OCR, QR, PDF signing — runs locally with vendored libraries.
The only network call is the *optional* S3 upload you trigger with your own
presigned URL.

**Is OCR 100% accurate?**
No OCR engine is. The image is preprocessed (upscale, contrast, Otsu binarize)
to greatly improve small/faint/low-contrast text, but accuracy still depends on
how legible the source is.

**Why WebM recordings and not MP4?**
`MediaRecorder` outputs WebM natively. Optional **Export as MP4** (popup toggle
or trim-panel checkbox) lazy-loads vendored `ffmpeg.wasm` (~30 MB) and
transcodes on-device. Skipping MP4 never loads those assets. See
[Usage — MP4 export](Usage#mp4-export).

**Can it capture Netflix/DRM content?**
No — DRM-protected content can't be captured (a browser restriction).

**Do I need Node / npm to use the extension?**
No. Node is only for running the test suites. To *use* the extension you just
load it unpacked.

**Should this be published as an npm/GitHub Package?**
No — a Chrome extension isn't consumed as a dependency. Distribute via GitHub
Releases (done automatically) and the Chrome Web Store.

**Why vanilla JS instead of React/Vue?**
No build step, instant popup, MV3-CSP-friendly, and the hard parts live in
Konva / pdf.js / Tesseract. TypeScript is the recommended next step if the code
grows — not a UI framework.

**The extension won't load after a change — what breaks it most often?**
A CSP with `worker-src blob:` (hangs Chrome's load), a Tesseract worker without
`workerBlobURL: false`, or missing vendored LSTM core files for OCR.
