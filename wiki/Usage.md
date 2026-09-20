# Usage

## Capture
- **Visible** — grabs the visible part of the tab (no share picker).
- **Area** — drag a rectangle on the page, then it crops to it.
- **Full page** — scrolls and stitches the whole page onto one tall image
  (hides sticky headers after the first slice, waits for lazy images, and stays
  under the ~32,767 px canvas limit).
- **Full screen / Window** — uses Chrome's mandatory "choose what to share"
  picker (a privacy rule that cannot be bypassed).
- **Delayed shot** — 3 / 5 / 10 s, then capture.

## Record
Screen recording to **WebM**, with optional microphone and tab/system audio.
Start/stop from the popup or a keyboard shortcut; a red badge shows while live.

## Editor (opens in a tab)
- **Crop** and annotate: arrow, rectangle, oval, freehand, highlighter, text,
  step counter, spotlight, and blur/pixelate (incl. OCR-guided text-only blur).
- **Backgrounds**: solid/gradient fill, drop shadow, rounded corners, padding.
- **Export**: PNG / JPEG / multi-page PDF, copy to clipboard, or upload to an
  S3-compatible bucket (paste a presigned PUT URL — the link is copied back).

## OCR & QR
- **OCR** extracts text offline (Tesseract.js). The image is preprocessed
  (upscale, grayscale, contrast stretch, Otsu binarize) so small/faint text
  reads far better. No OCR engine is 100% accurate — quality depends on the
  source legibility.
- **QR/barcode** decodes via the native `BarcodeDetector`, falling back to jsQR.

## PDF editor & signing
1. Open a PDF (button or drag-and-drop) and navigate pages.
2. **Signature** — draw, type, or upload; drag it onto the line and resize.
3. **Pen** and **highlighter** to mark up while reading; add text or a date.
4. **Save** — annotations overlay the original pages (text preserved), exported
   as `<name>-signed.pdf`.

## Share this page
The popup shows a live **QR of the current tab's URL** — copy the link, copy or
save the QR as PNG, or use the native share sheet.

## Keyboard shortcuts
| Action | Windows / Linux | macOS |
|---|---|---|
| Full-page capture | `Ctrl+Shift+E` | `⌘+Shift+E` |
| Area capture | `Ctrl+Shift+S` | `⌘+Shift+S` |
| Full-screen / Start–stop recording | set at `chrome://extensions/shortcuts` | |

Shortcuts fire only while Chrome is the focused app — they are not system-wide.
