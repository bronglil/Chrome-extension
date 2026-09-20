const { test, expect } = require("../fixtures.js");

// Average brightness (0–255) of a computed CSS color like "rgb(18, 21, 28)".
function brightness(rgb) {
  const m = rgb.match(/\d+/g).map(Number);
  return (m[0] + m[1] + m[2]) / 3;
}

async function bodyBrightness(page, scheme) {
  await page.emulateMedia({ colorScheme: scheme });
  const rgb = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  return brightness(rgb);
}

test.describe("System theme (light / dark)", () => {
  test("popup follows the system colour scheme", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    const light = await bodyBrightness(page, "light");
    const dark = await bodyBrightness(page, "dark");
    expect(light).toBeGreaterThan(180); // light background
    expect(dark).toBeLessThan(80);      // dark background
  });

  test("editor follows the system colour scheme", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/editor/editor.html`);
    const light = await bodyBrightness(page, "light");
    const dark = await bodyBrightness(page, "dark");
    expect(light).toBeGreaterThan(150);
    expect(dark).toBeLessThan(80);
  });

  test("PDF editor follows the system colour scheme", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/pdf/pdf-editor.html`);
    const light = await bodyBrightness(page, "light");
    const dark = await bodyBrightness(page, "dark");
    expect(light).toBeGreaterThan(150);
    expect(dark).toBeLessThan(80);
  });
});
