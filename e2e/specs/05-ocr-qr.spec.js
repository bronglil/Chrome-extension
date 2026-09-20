const { test, expect } = require("../fixtures.js");
const { seedCapture, openEditor, makeImageDataUrl, fileDataUrl } = require("../helpers.js");

test.describe("OCR & QR (offline)", () => {
  test("OCR extracts text from the capture", async ({ context, extensionId }) => {
    test.setTimeout(120_000); // Tesseract WASM load + recognition
    const img = await makeImageDataUrl(context, {
      w: 620, h: 200, bg: "#ffffff", textColor: "#000000", text: "HELLO OCR 12345",
    });
    const id = await seedCapture(context, img);
    const page = await openEditor(context, extensionId, id);
    await page.click("#btn-ocr");
    await expect(page.locator("#ocr-panel")).toBeVisible();
    await expect
      .poll(async () => (await page.inputValue("#ocr-text")).toUpperCase(), { timeout: 100_000 })
      .toContain("HELLO");
  });

  test("OCR reads a difficult low-contrast, small-font image", async ({ context, extensionId }) => {
    test.setTimeout(120_000);
    // Small, faint gray-on-gray text — needs the upscale + contrast + Otsu
    // preprocessing to be legible to the engine.
    const img = await makeImageDataUrl(context, {
      w: 520, h: 140, bg: "#d0d0d0", textColor: "#8c8c8c", font: 20, weight: "normal",
      text: "Invoice 2026 Total 4815",
    });
    const id = await seedCapture(context, img);
    const page = await openEditor(context, extensionId, id);
    await page.click("#btn-ocr");
    await expect(page.locator("#ocr-panel")).toBeVisible();
    const text = await expect
      .poll(async () => (await page.inputValue("#ocr-text")).toUpperCase(), { timeout: 100_000 })
      .toContain("INVOICE");
    // Digits are the hardest part — confirm the number survived preprocessing.
    expect((await page.inputValue("#ocr-text"))).toContain("4815");
  });

  test("QR code is decoded and its value shown", async ({ context, extensionId }) => {
    const id = await seedCapture(context, fileDataUrl("assets/qr.png"));
    const page = await openEditor(context, extensionId, id);
    await page.click("#btn-qr");
    await expect(page.locator("#qr-result")).toContainText("OK-42", { timeout: 30_000 });
  });
});
