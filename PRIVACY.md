# Privacy Policy — SnapShot Studio

_Last updated: 2026-09-20_

SnapShot Studio is designed to be **private by default**. Everything it does runs
**locally in your browser**. The extension has **no backend server**, performs
**no analytics or tracking**, and **does not collect, transmit, or sell any
personal data**.

## What data the extension handles

- **Captures, recordings, and documents** (screenshots, screen recordings, PDFs
  you open) are processed entirely on your device. They are held only in your
  browser's memory and in `chrome.storage.local` for the brief moment needed to
  pass a capture to the editor, then removed.
- **OCR and QR decoding** run fully offline using libraries bundled with the
  extension (Tesseract.js, jsQR). Image contents are **never uploaded**.
- **PDF signing** happens on your device with a bundled library (pdf-lib). Your
  document is never sent anywhere.
- **Preferences** (such as chosen colors or toggles), if stored, are kept in
  `chrome.storage.local` on your device only.

## Optional actions that leave your device

The extension only sends data off your device when **you explicitly ask it to**:

- **"Save to Downloads"** writes a file to your own computer.
- **"Copy to clipboard"** places content on your system clipboard.
- **"Upload to S3"** sends the current image to the exact **presigned URL you
  paste**. The data goes directly to the storage bucket you control; the
  extension does not route it through, or copy it to, any other service.
- **Screen/desktop capture** uses Chrome's built-in "choose what to share"
  picker; the extension only receives what you choose to share.

No other network requests are made.

## Permissions and why they are needed

- `activeTab`, `tabs`, `host_permissions` — read the current tab's URL/title and
  capture the visible page.
- `tabCapture`, `desktopCapture`, `offscreen` — capture and record the screen or
  a window (via the browser's own picker).
- `scripting` — inject the in-page selection overlay and full-page stitching.
- `storage` — hold a capture briefly between the popup and the editor, and store
  preferences on your device.
- `downloads` — save exported images/PDFs/recordings to your computer.
- `clipboardWrite` — copy images/text/links when you choose "Copy".
- `commands` — keyboard shortcuts.

## Children's privacy

The extension is a general-purpose tool and is not directed at children. It does
not collect any personal information from anyone.

## Changes to this policy

Any changes will be reflected in this file and on the project's website. The
"Last updated" date above indicates the latest revision.

## Contact

Questions about privacy: open an issue at
<https://github.com/bronglil/Chrome-extension/issues>.
