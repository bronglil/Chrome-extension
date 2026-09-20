const { test, expect } = require("../fixtures.js");
const path = require("node:path");
const fs = require("node:fs");

const SAMPLE = path.join(__dirname, "..", "assets", "sample.pdf");

async function openPdfEditor(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/pdf/pdf-editor.html`);
  await page.waitForFunction(() => window.__pdfEditor && window.pdfjsLib && window.PDFLib);
  return page;
}

async function loadSample(page) {
  await page.setInputFiles("#pe-open", SAMPLE);
  // Wait until the first page has rendered (stage built, pager shows count).
  await expect(page.locator("#pe-pageinfo")).toHaveText("1 / 2", { timeout: 30_000 });
  await page.waitForFunction(() => window.__pdfEditor.state.stage);
}

const overlayCount = (page, type) =>
  page.evaluate((t) => window.__pdfEditor.state.overlayLayer.find(t).length, type);

test.describe("PDF editor", () => {
  test("opens a PDF and reports the page count", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    const n = await page.evaluate(() => window.__pdfEditor.state.numPages);
    expect(n).toBe(2);
  });

  test("navigates between pages", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click("#pe-next");
    await expect(page.locator("#pe-pageinfo")).toHaveText("2 / 2");
    await page.click("#pe-prev");
    await expect(page.locator("#pe-pageinfo")).toHaveText("1 / 2");
  });

  test("highlighter draws a highlight stroke on the page", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="highlight"]');
    const box = await page.locator("#pe-stage").boundingBox();
    // Drag across a line of text.
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 260, box.y + 80);
    await page.mouse.move(box.x + 360, box.y + 80);
    await page.mouse.up();
    expect(await overlayCount(page, ".highlight")).toBe(1);
    // Highlight uses multiply blending so underlying text stays readable.
    const gco = await page.evaluate(
      () => window.__pdfEditor.state.overlayLayer.findOne(".highlight").globalCompositeOperation()
    );
    expect(gco).toBe("multiply");
  });

  test("pen draws a freehand stroke", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="pen"]');
    const box = await page.locator("#pe-stage").boundingBox();
    await page.mouse.move(box.x + 80, box.y + 120);
    await page.mouse.down();
    await page.mouse.move(box.x + 140, box.y + 150);
    await page.mouse.move(box.x + 200, box.y + 130);
    await page.mouse.up();
    expect(await overlayCount(page, ".pen")).toBe(1);
  });

  test("places a typed signature onto the page", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="sign"]');
    await expect(page.locator("#pe-sig-modal")).toBeVisible();
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    // Signature becomes a named Konva image on the overlay.
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.overlayLayer.find(".sig").length
    )).toBe(1);
  });

  test("signature persists across page navigation", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    // Add a signature on page 1.
    await page.click('.rail__tool[data-tool="sign"]');
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);
    // Go to page 2 (no sig) and back to page 1 (sig restored).
    await page.click("#pe-next");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(0);
    await page.click("#pe-prev");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);
  });

  test("exports a signed PDF larger than the original", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="sign"]');
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.click("#pe-save"),
    ]);
    // chrome.downloads applies the "-signed.pdf" name at save time; Playwright's
    // download event only sees the underlying blob URL, so assert on content.
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const outPath = await download.path();
    const bytes = fs.readFileSync(outPath);
    // Valid PDF header and bigger than the original (signature image embedded).
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(fs.statSync(SAMPLE).size);
  });
});
