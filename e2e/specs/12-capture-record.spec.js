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

async function samplePreview(page) {
  return page.evaluate(() => {
    const v = document.getElementById("screen-preview");
    const w = Math.min(160, v.videoWidth | 0);
    const h = Math.min(90, v.videoHeight | 0);
    const label = (v.srcObject && v.srcObject.getVideoTracks()[0]?.label) || "";
    if (!w || !h) return { w: v.videoWidth || 0, h: v.videoHeight || 0, mean: 0, max: 0, label };
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const y = data[i] + data[i + 1] + data[i + 2];
      sum += y;
      if (y > max) max = y;
    }
    const n = data.length / 4;
    return { w: v.videoWidth, h: v.videoHeight, mean: sum / n / 3, max: max / 3, label };
  });
}

async function sampleWebm(page, filePath) {
  const b64 = fs.readFileSync(filePath).toString("base64");
  return page.evaluate(async (data) => {
    const raw = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([raw], { type: "video/webm" }));
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.src = url;
    await v.play().catch(() => {});
    await new Promise((r) => {
      if (v.readyState >= 2 && v.videoWidth) return r();
      v.addEventListener("loadeddata", r, { once: true });
      setTimeout(r, 4000);
    });
    if (v.duration && v.duration > 0.25) {
      try {
        v.currentTime = Math.min(0.4, v.duration / 2);
        await new Promise((r) => {
          v.addEventListener("seeked", r, { once: true });
          setTimeout(r, 1500);
        });
      } catch (_) { /* ignore seek */ }
    }
    const w = Math.min(160, v.videoWidth | 0);
    const h = Math.min(90, v.videoHeight | 0);
    if (!w || !h) {
      URL.revokeObjectURL(url);
      return { w: v.videoWidth || 0, h: v.videoHeight || 0, mean: 0, max: 0, duration: v.duration || 0 };
    }
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    c.getContext("2d").drawImage(v, 0, 0, w, h);
    const px = c.getContext("2d").getImageData(0, 0, w, h).data;
    let sum = 0;
    let max = 0;
    for (let i = 0; i < px.length; i += 4) {
      const y = px[i] + px[i + 1] + px[i + 2];
      sum += y;
      if (y > max) max = y;
    }
    URL.revokeObjectURL(url);
    return {
      w: v.videoWidth,
      h: v.videoHeight,
      mean: sum / (px.length / 4) / 3,
      max: max / 3,
      duration: v.duration || 0,
    };
  }, b64);
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

  test("Recording preview and saved WebM contain live video frames", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const rec = await context.newPage();
    await rec.goto(
      `chrome-extension://${extensionId}/src/recorder/recorder.html?cam=0&mic=0&audio=0&saveAs=0&fake=1`
    );
    await rec.click("#btn-share");
    await expect(rec.locator("#live-chip")).toBeVisible({ timeout: 20_000 });
    await rec.waitForTimeout(1200);

    const preview = await samplePreview(rec);
    expect(preview.w).toBeGreaterThan(16);
    expect(preview.h).toBeGreaterThan(16);
    expect(preview.max).toBeGreaterThan(8);
    expect(preview.mean).toBeGreaterThan(2);

    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 30_000 }),
      rec.click("#btn-stop"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/);
    const file = await download.path();
    expect(fs.statSync(file).size).toBeGreaterThan(2000);

    const probe = await context.newPage();
    await probe.goto("about:blank");
    const saved = await sampleWebm(probe, file);
    expect(saved.w).toBeGreaterThan(16);
    expect(saved.h).toBeGreaterThan(16);
    expect(saved.max).toBeGreaterThan(8);
    expect(saved.mean).toBeGreaterThan(2);
  });

  test("Desktop picker recording is not a black screen when auto-selected", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await context.newPage();
    await rec.goto(
      `chrome-extension://${extensionId}/src/recorder/recorder.html?cam=0&mic=0&audio=0&saveAs=0`
    );
    await rec.click("#btn-share");
    try {
      await expect(rec.locator("#live-chip")).toBeVisible({ timeout: 10_000 });
    } catch {
      test.skip(true, "Chrome did not auto-select a desktop capture source");
    }
    await rec.waitForTimeout(800);
    const preview = await samplePreview(rec);
    expect(preview.w).toBeGreaterThan(16);
    expect(preview.h).toBeGreaterThan(16);
    expect(preview.max, "shared screen preview should not be black").toBeGreaterThan(8);
    expect(/snapshot studio|recorder\.html/i.test(preview.label || "")).toBeFalsy();
    await rec.click("#btn-stop").catch(() => {});
  });
});
