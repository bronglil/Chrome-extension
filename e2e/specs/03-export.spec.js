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

  test("PDF without Searchable never loads the OCR worker", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context, {
      w: 480, h: 160, bg: "#ffffff", textColor: "#000000", text: "PLAIN PDF",
    }));
    const page = await openEditor(context, extensionId, id);
    await expect(page.locator("#opt-pdf-ocr")).not.toBeChecked();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.click("#btn-pdf"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const loaded = await page.evaluate(() => window.__editor.getOcrWorkerLoaded());
    expect(loaded).toBe(false);
  });

  test("Searchable PDF embeds OCR text that Find can read", async ({ context, extensionId }) => {
    test.setTimeout(180_000);
    const marker = "SEARCHABLE42";
    const id = await seedCapture(context, await makeImageDataUrl(context, {
      w: 640, h: 220, bg: "#ffffff", textColor: "#000000", text: `Invoice ${marker}`,
    }));
    const page = await openEditor(context, extensionId, id);
    await page.locator("#opt-pdf-ocr").check();
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 150_000 }),
      page.click("#btn-pdf"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const buf = require("node:fs").readFileSync(await download.path());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");

    // Load vendored pdf.js into the editor page to read the text layer.
    const text = await page.evaluate(async ({ bytes, base }) => {
      if (!window.pdfjsLib) {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = base + "vendor/pdfjs/pdf.min.js";
          s.onload = () => res();
          s.onerror = () => rej(new Error("pdf.js load failed"));
          document.head.appendChild(s);
        });
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = base + "vendor/pdfjs/pdf.worker.min.js";
      }
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
      let all = "";
      for (let i = 1; i <= pdf.numPages; i++) {
        const p = await pdf.getPage(i);
        const tc = await p.getTextContent();
        all += tc.items.map((it) => it.str).join(" ") + " ";
      }
      return all;
    }, { bytes: [...buf], base: `chrome-extension://${extensionId}/` });

    expect(text.toUpperCase()).toContain(marker);
    expect(await page.evaluate(() => window.__editor.getOcrWorkerLoaded())).toBe(true);
  });
});
