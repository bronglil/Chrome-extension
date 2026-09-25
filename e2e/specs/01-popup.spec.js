const { test, expect } = require("../fixtures.js");

test.describe("Popup UI", () => {
  test("renders every capture mode and recording controls", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    // Web-page capture family (no share picker).
    await expect(page.locator('[data-action="capture-visible"]').first()).toBeVisible();
    await expect(page.locator('[data-action="capture-area"]').first()).toBeVisible();
    await expect(page.locator('[data-action="capture-full-page"]')).toBeVisible();
    await expect(page.locator('[data-action="capture-element"]')).toBeVisible();
    await expect(page.locator('[data-action="ocr-area"]')).toBeVisible();

    // Delay presets.
    await expect(page.locator('[data-delay="3"]')).toBeVisible();
    await expect(page.locator('[data-delay="5"]')).toBeVisible();
    await expect(page.locator('[data-delay="10"]')).toBeVisible();

    // Recording controls — camera, mic, system audio, and quality are independently optional.
    await expect(page.locator("#rec-toggle")).toBeVisible();
    await expect(page.locator("#rec-cam")).toBeVisible();
    await expect(page.locator("#rec-mic")).toBeVisible();
    await expect(page.locator("#rec-audio")).toBeVisible();
    await expect(page.locator("#rec-quality")).toBeVisible();
    await expect(page.locator("#rec-blur")).toBeVisible();
    await expect(page.locator("#rec-label")).toHaveText("Start recording");
  });

  test("delay buttons carry the correct delay data", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const delays = await page.$$eval("[data-delay]", (els) => els.map((e) => e.dataset.delay));
    expect(delays).toEqual(["3", "5", "10"]);
  });

  test("recording button flips between Start and Stop from recording state", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await expect(page.locator("#rec-label")).toHaveText("Start recording");

    await page.evaluate(() => {
      window.__applyRec({ active: true, recording: true, startedAt: 0, pending: true });
    });
    await expect(page.locator("#rec-label")).toHaveText("Starting…");

    await page.evaluate(() => {
      window.__applyRec({
        active: true,
        recording: true,
        startedAt: Date.now() - 2000,
        pending: false,
      });
    });
    await expect(page.locator("#rec-label")).toHaveText("Stop recording");
    await expect(page.locator("#rec-status")).toBeVisible();

    await page.evaluate(() => {
      window.__applyRec({ active: false, recording: false, startedAt: 0, pending: false });
    });
    await expect(page.locator("#rec-label")).toHaveText("Start recording");
  });
});
