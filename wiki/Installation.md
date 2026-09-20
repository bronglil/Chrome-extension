# Installation

## Load the extension (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder containing `manifest.json`.
4. Pin **SnapShot Studio** to the toolbar.

No build step is required — it is plain JavaScript. Requires **Chrome 116+**
(offscreen documents).

## Get the code

Download the latest release ZIP from the
[Releases page](https://github.com/bronglil/Chrome-extension/releases), or clone:

```bash
cd ~/Documents/GitHub
git clone https://github.com/bronglil/Chrome-extension.git
cd Chrome-extension
npm ci        # only needed to run the test suites
```

## Run the tests

```bash
npm test          # unit tests (Node built-in runner, no browser)
npm run test:e2e  # end-to-end in real Chromium (auto-uses Xvfb on Linux)
npm run test:all  # both
```

On **macOS/Windows** the E2E launcher runs Chromium directly; on **Linux**
without a display it wraps Playwright in `xvfb-run`. Install the browser once
with `npx playwright install chromium` if Playwright's own build is used.

## No environment variables required

Cloning, `npm ci`, and loading the extension need **no `.env`, keys, or
tokens** — everything runs offline. Optional: `CHROMIUM_PATH` to force a
specific browser for E2E.
