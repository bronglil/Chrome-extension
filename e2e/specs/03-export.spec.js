const { test, expect } = require("../fixtures.js");
const { seedCapture, openEditor, installExportSpies, makeImageDataUrl } = require("../helpers.js");

test.describe("Editor — export", () => {
  test("PNG export calls downloads with a png data URL", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await installExportSpies(page);
    await page.click("#btn-png");
    const dl = await page.evaluate(() => window.__downloads);
    expect(dl.length).toBe(1);
    expect(dl[0].filename).toMatch(/\.png$/);
    expect(dl[0].url.startsWith("data:image/png")).toBe(true);
  });

  test("JPEG export calls downloads with a jpeg data URL", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await installExportSpies(page);
    await page.click("#btn-jpg");
    const dl = await page.evaluate(() => window.__downloads);
    expect(dl[0].filename).toMatch(/\.jpg$/);
    expect(dl[0].url.startsWith("data:image/jpeg")).toBe(true);
  });

  test("Copy writes an image to the clipboard", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await installExportSpies(page);
    await page.click("#btn-copy");
    await expect.poll(() => page.evaluate(() => window.__clipboard.filter((c) => c.kind === "image").length)).toBeGreaterThan(0);
  });

  test("PDF export produces a .pdf download", async ({ context, extensionId }) => {
    // Tall image so the multi-page split path runs.
    const id = await seedCapture(context, await makeImageDataUrl(context, { w: 600, h: 2200 }));
    const page = await openEditor(context, extensionId, id);
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.click("#btn-pdf"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });
});
