# Chrome Web Store — Listing kit

Everything needed to submit **SnapShot Studio** to the Chrome Web Store. Copy the
sections below into the Developer Dashboard fields.

---

## Basics
- **Name:** SnapShot Studio — Screenshot, Recorder & PDF Sign
- **Category:** Productivity (secondary: Developer Tools)
- **Language:** English
- **Website:** https://bronglil.github.io/Chrome-extension/
- **Privacy policy URL:** https://bronglil.github.io/Chrome-extension/privacy.html
- **Support:** https://github.com/bronglil/Chrome-extension/issues

## Summary (≤132 chars)
Screenshots, full-page capture, screen recording, offline OCR & QR, annotation, and PDF signing — fast, private, 100% offline.

## Detailed description
SnapShot Studio is an all-in-one capture and markup tool that works entirely in
your browser — no account, no servers, nothing leaves your device.

CAPTURE
• Visible area, drag-to-select, and full-page scroll-and-stitch (handles sticky
  headers and lazy-loaded images).
• Full screen or a specific window (via Chrome's share picker).
• Delayed capture: 3 / 5 / 10 seconds.

RECORD
• Record the screen or a window to WebM, with optional microphone and
  tab/system audio.

ANNOTATE
• Arrow, rectangle, oval, freehand, highlighter, text, step counter, spotlight,
  and blur/pixelate (including OCR-guided text-only blur).
• Backgrounds: solid/gradient fill, drop shadow, rounded corners, padding.
• Export PNG, JPEG, multi-page PDF, copy to clipboard, or upload to your own
  S3 bucket.

OCR & QR (fully offline)
• Extract text from any capture with on-device OCR (image preprocessing makes
  small and low-contrast text far more accurate).
• Decode QR codes and barcodes.

PDF SIGNING
• Open a PDF, place a signature exactly where you want (draw, type, or upload),
  pen and highlight while you read, and acknowledge with an "AK" stamp on every
  page. Exports keep the original pages intact.

SHARE
• The popup shows a live QR code of the current page's URL — copy the link, copy
  or save the QR, or share via the native share sheet.

PRIVATE BY DESIGN
• 100% offline. No analytics, no tracking, no data collection. Everything runs
  locally with bundled libraries.

## Single purpose (required field)
Capture, annotate, record, and sign content from the browser — screenshots,
screen recordings, and PDFs — with all processing done locally on the user's
device.

## Permission justifications (paste per permission)
- **activeTab / tabs / host access (`<all_urls>`):** read the current tab's URL
  and title and capture the visible page for screenshots and full-page capture.
- **tabCapture / desktopCapture / offscreen:** capture and record the screen or a
  window; the offscreen document runs the media APIs MV3 service workers cannot.
- **scripting:** inject the in-page area-selection overlay and the full-page
  scroll-and-stitch logic.
- **storage:** briefly hold a capture between the popup and the editor, and store
  user preferences locally.
- **downloads:** save exported screenshots, PDFs, and recordings.
- **clipboardWrite:** copy an image, extracted text, or a link when the user
  chooses "Copy".
- **commands:** keyboard shortcuts for capture and recording.

## Data-safety / privacy answers
- Does the item collect or use user data? **No.**
- Sold to third parties? **No.** Used for anything unrelated to the single
  purpose? **No.** Used to determine creditworthiness? **No.**
- All processing is local; the only outbound data is to a user-supplied S3
  presigned URL or the user's own Downloads/clipboard.

## Assets checklist
- [ ] Store icon 128×128 (see `icons/icon128.png` — replace with a designed icon, issue #24)
- [ ] At least 1 screenshot 1280×800 or 640×400 (use `docs/` renders: popup, editor, PDF signer, landing)
- [ ] Small promo tile 440×280 (optional but recommended)
- [ ] Marquee promo 1400×560 (optional)

## Build the upload package
The Release workflow already produces a zip on version change; or locally:

```bash
zip -r snapshot-studio.zip manifest.json src vendor icons -x '*.map'
```

Upload that zip in the Developer Dashboard. A one-time $5 developer registration
is required to publish.

## Pre-submission checklist
- [ ] Privacy policy URL live (Pages enabled) — see PR for issue #21
- [ ] Permissions reviewed/minimized where possible (issue #20)
- [ ] Designed icon set (issue #24)
- [ ] Screenshots exported at store dimensions
- [ ] Version in `manifest.json` matches the intended release tag
