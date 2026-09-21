const { test, expect } = require("../fixtures.js");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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

async function sw(context) {
  let [s] = context.serviceWorkers();
  if (!s) s = await context.waitForEvent("serviceworker");
  return s;
}

test.describe("Screenshot + recording (end to end)", () => {
  test("Visible capture opens the editor with the screenshot", async ({ context }) => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();

    const editorWait = context.waitForEvent("page", {
      predicate: (p) => (p.url() || "").includes("src/editor/editor.html"),
      timeout: 30_000,
    });
    await (await sw(context)).evaluate(async () => {
      await chrome.storage.session.set({
        pendingJob: { type: "CAPTURE", action: "capture-visible", at: Date.now() },
      });
    });

    const editor = await editorWait;
    await editor.waitForFunction(
      () => window.Konva && window.Konva.stages && window.Konva.stages.length > 0,
      null,
      { timeout: 30_000 }
    );
    await expect(editor.locator("#empty-state")).toBeHidden();
    const imgs = await editor.evaluate(() => window.Konva.stages[0].find("Image").length);
    expect(imgs).toBeGreaterThanOrEqual(1);
  });

  test("Area drag captures the selected rectangle into the editor", async ({ context }) => {
    test.setTimeout(60_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();

    const editorWait = context.waitForEvent("page", {
      predicate: (p) => (p.url() || "").includes("src/editor/editor.html"),
      timeout: 45_000,
    });
    await (await sw(context)).evaluate(async () => {
      await chrome.storage.session.set({
        pendingJob: { type: "CAPTURE", action: "capture-area", at: Date.now() },
      });
    });

    await expect(page.locator(".snapshot-overlay")).toBeVisible({ timeout: 15_000 });
    await page.mouse.move(90, 110);
    await page.mouse.down();
    await page.mouse.move(280, 320);
    await page.mouse.up();

    const editor = await editorWait;
    await editor.waitForFunction(
      () => window.Konva && window.Konva.stages && window.Konva.stages.length > 0,
      null,
      { timeout: 30_000 }
    );
    await expect(editor.locator("#empty-state")).toBeHidden();
  });

  test("Recording starts, then Stop saves a WebM file", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const rec = await context.newPage();
    await rec.goto(
      `chrome-extension://${extensionId}/src/recorder/recorder.html?cam=0&mic=0&audio=0&saveAs=0`
    );
    await rec.click("#btn-share");
    await expect(rec.locator("#live-chip")).toBeVisible({ timeout: 20_000 });
    await rec.waitForTimeout(1500);
    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 30_000 }),
      rec.click("#btn-stop"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/);
    const file = await download.path();
    expect(fs.statSync(file).size).toBeGreaterThan(200);
  });
});
