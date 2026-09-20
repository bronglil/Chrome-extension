const { test, expect } = require("../fixtures.js");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

let server, PORT;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(__dirname, "..", "pages", path.basename(req.url.split("?")[0]));
    fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { "Content-Type": "text/html" }); res.end(d); } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
});
test.afterAll(() => server && server.close());

async function sw(context) {
  let [s] = context.serviceWorkers();
  if (!s) s = await context.waitForEvent("serviceworker");
  return s;
}
async function tabId(context, part) {
  return (await sw(context)).evaluate(async (p) => {
    const tabs = await chrome.tabs.query({});
    return (tabs.find((t) => (t.url || "").includes(p)) || {}).id;
  }, part);
}

test.describe("On-page QR overlay (opt-in)", () => {
  test("popup toggle is off by default", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await expect(page.locator("#page-qr-toggle")).not.toBeChecked();
  });

  test("renders an overlay QR when enabled, and removes it on hide", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const id = await tabId(context, "tall-page.html");

    // Enable + inject (as the service worker does on toggle).
    await (await sw(context)).evaluate(async (tabId) => {
      await chrome.storage.local.set({ pageQrEnabled: true });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["vendor/qrcode-generator.min.js", "src/content/qr-overlay.js"],
      });
    }, id);

    // The overlay lives in an open shadow root; Playwright pierces it.
    await expect(page.locator("#snapshot-qr-host")).toBeAttached();
    const src = await page.locator("#snapshot-qr-host .qr").getAttribute("src");
    expect(src.startsWith("data:image/")).toBe(true);

    // Hide via the message the SW sends when toggled off.
    await (await sw(context)).evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "PAGE_QR_HIDE" }), id);
    await expect(page.locator("#snapshot-qr-host")).toHaveCount(0);
  });

  test("overlay QR decodes back to the page URL", async ({ context, extensionId }) => {
    const page = await context.newPage();
    const url = `http://127.0.0.1:${PORT}/tall-page.html`;
    await page.goto(url);
    const id = await tabId(context, "tall-page.html");
    await (await sw(context)).evaluate(async (tabId) => {
      await chrome.storage.local.set({ pageQrEnabled: true });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["vendor/qrcode-generator.min.js", "src/content/qr-overlay.js"] });
    }, id);
    await expect(page.locator("#snapshot-qr-host .qr")).toBeAttached();

    const jsqrUrl = `chrome-extension://${extensionId}/vendor/jsqr.min.js`;
    const decoded = await page.evaluate(async (jsqrUrl) => {
      const img = document.getElementById("snapshot-qr-host").shadowRoot.querySelector(".qr");
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const data = c.getContext("2d").getImageData(0, 0, c.width, c.height);
      const s = document.createElement("script");
      s.src = jsqrUrl;
      await new Promise((r) => { s.onload = r; document.head.appendChild(s); });
      const res = window.jsQR(data.data, data.width, data.height);
      return res && res.data;
    }, jsqrUrl);
    expect(decoded).toBe(url);
  });
});
