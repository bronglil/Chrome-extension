// Per-tool performance budgets. Each test measures a real operation end to end
// and asserts a generous upper bound (to catch gross regressions without being
// flaky on slow CI runners) while logging the actual timing.
const { test, expect } = require("../fixtures.js");
const { seedCapture, openEditor, makeImageDataUrl, installExportSpies, fileDataUrl } = require("../helpers.js");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

function log(name, ms, budget) {
  // eslint-disable-next-line no-console
  console.log(`  ⏱  ${name}: ${Math.round(ms)}ms (budget ${budget}ms)`);
}

// Static server for the full-page test.
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

test.describe("Performance budgets (per tool)", () => {
  test("QR encode is fast (avg < 60ms over 20 runs)", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.waitForFunction(() => typeof window.__snapRenderQR === "function");
    const avg = await page.evaluate(() => {
      const url = "https://example.com/some/deep/path?q=performance&n=20";
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) window.__snapRenderQR(url + i);
      return (performance.now() - t0) / 20;
    });
    log("QR encode (avg)", avg, 60);
    expect(avg).toBeLessThan(60);
  });

  test("Editor flatten + PNG export < 2500ms", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context, { w: 1280, h: 800 }));
    const page = await openEditor(context, extensionId, id);
    await installExportSpies(page);
    const t0 = Date.now();
    await page.click("#btn-png");
    await expect.poll(() => page.evaluate(() => window.__downloads.length)).toBe(1);
    const ms = Date.now() - t0;
    log("Editor PNG export", ms, 2500);
    expect(ms).toBeLessThan(2500);
  });

  test("Full-page scroll-and-stitch < 30s", async ({ context }) => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const tabId = await (await sw(context)).evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      return (tabs.find((t) => (t.url || "").includes("tall-page.html")) || {}).id;
    });
    const t0 = Date.now();
    const r = await (await sw(context)).evaluate(async (tabId) => {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["src/lib/utils.js", "src/content/content.js"] });
      return chrome.tabs.sendMessage(tabId, { type: "START_FULL_PAGE" });
    }, tabId);
    const ms = Date.now() - t0;
    log("Full-page stitch", ms, 30000);
    expect(r.height).toBeGreaterThan(1500);
    expect(ms).toBeLessThan(30000);
  });

  test("OCR (with preprocessing) < 30s", async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const img = await makeImageDataUrl(context, { w: 620, h: 200, bg: "#fff", textColor: "#000", text: "PERF OCR 2026" });
    const id = await seedCapture(context, img);
    const page = await openEditor(context, extensionId, id);
    const t0 = Date.now();
    await page.click("#btn-ocr");
    await expect.poll(async () => (await page.inputValue("#ocr-text")).toUpperCase(), { timeout: 80_000 }).toContain("PERF");
    const ms = Date.now() - t0;
    log("OCR recognize", ms, 30000);
    expect(ms).toBeLessThan(30000);
  });

  test("QR decode < 1500ms", async ({ context, extensionId }) => {
    const id = await seedCapture(context, fileDataUrl("assets/qr.png"));
    const page = await openEditor(context, extensionId, id);
    const t0 = Date.now();
    await page.click("#btn-qr");
    await expect(page.locator("#qr-result")).toContainText("OK-42", { timeout: 10_000 });
    const ms = Date.now() - t0;
    log("QR decode", ms, 1500);
    expect(ms).toBeLessThan(1500);
  });

  test("PDF open + first-page render < 15s", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/pdf/pdf-editor.html`);
    await page.waitForFunction(() => window.__pdfEditor && window.pdfjsLib && window.PDFLib);
    const t0 = Date.now();
    await page.setInputFiles("#pe-open", path.join(__dirname, "..", "assets", "sample.pdf"));
    await expect(page.locator("#pe-pageinfo")).toHaveText("1 / 2", { timeout: 30_000 });
    const ms = Date.now() - t0;
    log("PDF open+render", ms, 15000);
    expect(ms).toBeLessThan(15000);
  });

  test("PDF sign + export < 15s", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/pdf/pdf-editor.html`);
    await page.waitForFunction(() => window.__pdfEditor && window.PDFLib);
    await page.setInputFiles("#pe-open", path.join(__dirname, "..", "assets", "sample.pdf"));
    await expect(page.locator("#pe-pageinfo")).toHaveText("1 / 2", { timeout: 30_000 });
    await page.click('.rail__tool[data-tool="sign"]');
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    await expect.poll(() => page.evaluate(() => window.__pdfEditor.state.overlayLayer.find(".sig").length)).toBe(1);
    const t0 = Date.now();
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.click("#pe-save")]);
    const ms = Date.now() - t0;
    log("PDF export", ms, 15000);
    expect(dl.suggestedFilename()).toMatch(/\.pdf$/);
    expect(ms).toBeLessThan(15000);
  });
});
