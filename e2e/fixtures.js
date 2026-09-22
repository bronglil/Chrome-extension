// Shared Playwright fixtures: launch a persistent Chromium context with the
// unpacked SnapShot Studio extension loaded, and expose its extension id.
//
// Notes on Chrome extension E2E:
//  * MV3 extensions require a persistent context (not the default launch()).
//  * The extension id is derived from its background service worker URL.
//  * Desktop-picker flows (getDisplayMedia / desktopCapture) cannot be
//    scripted headlessly — those are exercised via the paths that don't need
//    a picker (tab capture, the editor, OCR/QR), which cover the real logic.
const base = require("@playwright/test");
const path = require("node:path");
const fs = require("node:fs");

const EXT_ROOT = path.join(__dirname, ".."); // folder containing manifest.json

// Extensions need full Chromium (not headless-shell). Prefer an explicit
// CHROMIUM_PATH, then the pre-installed container browser, else let Playwright
// use its own installed chromium (CI runs `playwright install chromium`).
function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const bundled = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (fs.existsSync(bundled)) return bundled;
  return undefined; // Playwright resolves its own executable
}
const CHROMIUM_PATH = resolveChromium();

const test = base.test.extend({
  context: async ({}, use) => {
    // MV3 extensions only load in HEADED Chromium. In CI/containers this runs
    // under Xvfb (see the `test:e2e` script), so a virtual display is present.
    const context = await base.chromium.launchPersistentContext("", {
      headless: false,
      executablePath: CHROMIUM_PATH,
      args: [
        `--disable-extensions-except=${EXT_ROOT}`,
        `--load-extension=${EXT_ROOT}`,
        "--disable-features=DisableLoadExtensionCommandLineSwitch",
        "--no-sandbox",
        "--auto-accept-this-tab-capture",
        "--auto-select-desktop-capture-source=Entire screen",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context }, use) => {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 30_000 });
    const id = sw.url().split("/")[2];
    await use(id);
  },
});

const expect = base.expect;
module.exports = { test, expect, EXT_ROOT };
