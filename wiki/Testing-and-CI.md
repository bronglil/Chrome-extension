# Testing and CI

## Suites

**Unit — `test/` (20 tests, Node built-in runner)**
Covers the reusable core in `src/lib/utils.js`: `clampRect`, `throttle`,
`rafDebounce`, `loadImage`, `blobToDataUrl`, and the device-adaptive
`deviceProfile()`. Browser globals are stubbed in `test/env.js` via a VM sandbox.

**E2E — `e2e/` (41 tests, Playwright)**
Loads the **real unpacked extension** into Chromium and drives it:

| Spec | Covers |
|------|--------|
| `00-smoke` | Extension loads, service worker registers |
| `01-popup` | Capture buttons + recording controls |
| `02-editor-annotate` | Konva tools, undo, gradient/padding |
| `03-export` | PNG / JPEG / clipboard / multi-page PDF |
| `04-capture` | `captureVisibleTab`, full-page stitch, area select |
| `05-ocr-qr` | Offline OCR (incl. a hard low-contrast case) + QR decode |
| `06-pdf` | Open, page nav, pen, highlighter, signature, signed-PDF export |
| `07-theme` | Popup/editor/PDF follow the system light/dark scheme |
| `08-page-qr` | Page-URL QR: render, copy, and an encode→decode round-trip |
| `09-performance` | A per-tool timing budget for every major feature |

## Running

```bash
npm test          # unit
npm run test:e2e  # e2e (auto-uses Xvfb on Linux; direct on macOS/Windows)
npm run test:all  # both
```

> MV3 extensions load only in **headed** Chromium. The fixture picks the
> pre-installed browser, or Playwright's own if none (override with
> `CHROMIUM_PATH`). Desktop-picker flows can't be scripted (a browser privacy
> control) and are validated manually.

## CI

`.github/workflows/ci.yml` runs on **every push and PR**: unit tests, a
version-sync check, then the full E2E suite on Chromium under Xvfb.

**Require green CI to merge** (recommended): Settings → Branches → add a ruleset
for `master`, require status checks, and select **Unit tests** and
**End-to-end (Chromium)**.

## Versioning & releases

- `.github/workflows/release.yml` tags `vX.Y.Z` and publishes a Release with a
  zipped unpacked extension when the version changes on `master`.
- `package.json` and `manifest.json` stay in lock-step:
  `npm version <patch|minor|major>` bumps both (`npm run version:check` /
  `version:sync` verify or sync).
