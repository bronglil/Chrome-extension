const { test, expect } = require("../fixtures.js");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

// Serve e2e/pages over localhost so the content script (matches <all_urls>) can
// be injected on a real http page — file:// URLs are blocked for extensions.
let server, PORT;
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(__dirname, "..", "pages", path.basename(req.url.split("?")[0]));
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  PORT = server.address().port;
});
test.afterAll(() => server && server.close());

// Find the chrome tab id for a given URL substring, from inside the SW.
async function tabIdFor(context, urlPart) {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  return sw.evaluate(async (part) => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((t) => (t.url || "").includes(part));
    return t ? t.id : null;
  }, urlPart);
}
async function sw(context) {
  let [s] = context.serviceWorkers();
  if (!s) s = await context.waitForEvent("serviceworker");
  return s;
}

test.describe("Capture pipeline (content script)", () => {
  test("captureVisibleTab returns a PNG for the active tab", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const head = await (await sw(context)).evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      // captureVisibleTab can transiently fail with "image readback failed" on
      // GPU-less CI compositors — retry a few times.
      let url = "";
      for (let i = 0; i < 6; i++) {
        try { url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" }); break; }
        catch (_) { await new Promise((r) => setTimeout(r, 300)); }
      }
      return url.slice(0, 22);
    });
    expect(head).toContain("data:image/png");
  });

  test("full-page scroll-and-stitch produces a tall stitched image", async ({ context }) => {
    test.setTimeout(90_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const tabId = await tabIdFor(context, "tall-page.html");
    expect(tabId).not.toBeNull();

    const result = await (await sw(context)).evaluate(async (tabId) => {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/area-select.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/lib/utils.js", "src/content/content.js"] });
      const r = await chrome.tabs.sendMessage(tabId, { type: "START_FULL_PAGE" });
      return { height: r.height, width: r.width, tiles: r.tiles, len: (r.dataUrl || "").length };
    }, tabId);

    // The page is ~4000px tall; the stitched canvas must be far taller than a
    // single viewport and stay under the browser's ~32767px canvas cap.
    expect(result.height).toBeGreaterThan(1500);
    expect(result.height).toBeLessThanOrEqual(32767);
    expect(result.len).toBeGreaterThan(1000);
  });

  test("area selection returns the dragged rectangle", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const tabId = await tabIdFor(context, "tall-page.html");

    // Start selection without awaiting; the promise resolves on mouse-up.
    await (await sw(context)).evaluate(async (tabId) => {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ["src/content/area-select.css"] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/lib/utils.js", "src/content/content.js"] });
      globalThis.__areaPromise = chrome.tabs.sendMessage(tabId, { type: "START_AREA_SELECT" });
    }, tabId);

    // Drag a rectangle on the in-page overlay.
    await expect(page.locator(".snapshot-overlay")).toBeVisible();
    await page.mouse.move(100, 120);
    await page.mouse.down();
    await page.mouse.move(260, 300);
    await page.mouse.move(340, 380);
    await page.mouse.up();

    const rect = await (await sw(context)).evaluate(() => globalThis.__areaPromise);
    expect(rect).not.toBeNull();
    expect(rect.width).toBeGreaterThan(100);
    expect(rect.height).toBeGreaterThan(100);
  });
});
