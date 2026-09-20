const { test, expect } = require("../fixtures.js");

async function openPopup(context, extensionId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.waitForFunction(() => typeof window.__snapRenderQR === "function" && typeof window.qrcode === "function");
  return page;
}

test.describe("Page QR (share current page)", () => {
  test("renders a QR image and the URL for an http(s) page", async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId);
    const url = "https://example.com/article?id=42";
    await page.evaluate((u) => window.__snapRenderQR(u), url);

    await expect(page.locator("#qr-section")).toBeVisible();
    await expect(page.locator("#qr-url")).toHaveText(url);
    const src = await page.locator("#qr-img").getAttribute("src");
    expect(src.startsWith("data:image/")).toBe(true);
    expect(src.length).toBeGreaterThan(200); // an actual encoded image
  });

  test("hides the QR and shows a note for non-shareable pages", async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId);
    await page.evaluate(() => window.__snapRenderQR("chrome://extensions"));
    await expect(page.locator("#qr-section")).toBeHidden();
    await expect(page.locator("#qr-note")).toBeVisible();
  });

  test("Copy link puts the page URL on the clipboard", async ({ context, extensionId }) => {
    const page = await openPopup(context, extensionId);
    await page.evaluate(() => {
      window.__copied = [];
      navigator.clipboard.writeText = async (t) => { window.__copied.push(t); };
    });
    const url = "https://example.com/x";
    await page.evaluate((u) => window.__snapRenderQR(u), url);
    await page.click("#qr-copy-link");
    await expect.poll(() => page.evaluate(() => window.__copied)).toContain(url);
  });

  test("the encoded QR actually decodes back to the URL", async ({ context, extensionId }) => {
    // Round-trip: encode with qrcode-generator, decode with the bundled jsQR.
    const page = await openPopup(context, extensionId);
    const url = "https://snapshot.example/roundtrip/7";
    const decoded = await page.evaluate(async (u) => {
      window.__snapRenderQR(u);
      const img = document.getElementById("qr-img");
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      // Load jsQR from the vendored file into this page.
      const s = document.createElement("script");
      s.src = "../../vendor/jsqr.min.js";
      await new Promise((r) => { s.onload = r; document.head.appendChild(s); });
      const res = window.jsQR(data.data, data.width, data.height);
      return res && res.data;
    }, url);
    expect(decoded).toBe(url);
  });
});
