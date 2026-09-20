const { test, expect } = require("../fixtures.js");
const { seedCapture, openEditor, makeImageDataUrl } = require("../helpers.js");

// Drag on the Konva stage in image coordinates (accounting for padding offset 0).
async function dragOnStage(page, from, to) {
  const box = await page.locator("#stage").boundingBox();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2);
  await page.mouse.move(box.x + to.x, box.y + to.y);
  await page.mouse.up();
}

function selectTool(page, tool) {
  return page.click(`.ed-tool[data-tool="${tool}"]`);
}
const countByType = (page, type) =>
  page.evaluate((t) => window.Konva.stages[0].find(t).length, type);

test.describe("Editor — annotation tools", () => {
  test("loads a seeded capture onto the Konva stage", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context), { kind: "visible" });
    const page = await openEditor(context, extensionId, id);
    const imgs = await countByType(page, "Image");
    expect(imgs).toBeGreaterThanOrEqual(1); // base image present
    await expect(page.locator("#empty-state")).toBeHidden(); // no "No image yet" over the capture
  });

  test("shows webpage details and download actions after a capture", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context, { w: 400, h: 300 }), {
      kind: "fullpage",
      title: "Example Domain",
      url: "https://example.com/docs",
    });
    const page = await openEditor(context, extensionId, id);
    await expect(page.locator("#source-panel")).toBeVisible();
    await expect(page.locator("#src-title")).toHaveText("Example Domain");
    await expect(page.locator("#src-url")).toHaveAttribute("href", "https://example.com/docs");
    await expect(page.locator("#src-facts")).toContainText("Full page");
    await expect(page.locator("#src-png")).toBeVisible();
    await expect(page.locator("#src-pdf")).toBeVisible();
    await expect(page.locator("#mode-label")).toContainText("example.com");
  });

  test("draws a rectangle annotation", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    const before = await countByType(page, "Rect");
    await selectTool(page, "rect");
    await dragOnStage(page, { x: 20, y: 20 }, { x: 120, y: 90 });
    expect(await countByType(page, "Rect")).toBeGreaterThan(before);
  });

  test("draws an arrow annotation", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await selectTool(page, "arrow");
    await dragOnStage(page, { x: 10, y: 10 }, { x: 140, y: 100 });
    expect(await countByType(page, "Arrow")).toBe(1);
  });

  test("draws an oval annotation", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await selectTool(page, "oval");
    await dragOnStage(page, { x: 15, y: 15 }, { x: 120, y: 80 });
    expect(await countByType(page, "Ellipse")).toBe(1);
  });

  test("adds a step counter that increments", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await selectTool(page, "step");
    const box = await page.locator("#stage").boundingBox();
    await page.mouse.click(box.x + 40, box.y + 40);
    await page.mouse.click(box.x + 90, box.y + 60);
    // Two step groups, labelled "1" and "2".
    const labels = await page.evaluate(() =>
      window.Konva.stages[0].find("Text").map((t) => t.text()).filter((t) => /^\d+$/.test(t))
    );
    expect(labels).toContain("1");
    expect(labels).toContain("2");
  });

  test("undo removes the most recent annotation", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    await selectTool(page, "rect");
    await dragOnStage(page, { x: 20, y: 20 }, { x: 80, y: 60 });
    const withRect = await countByType(page, "Rect");
    await page.click("#btn-undo");
    expect(await countByType(page, "Rect")).toBeLessThan(withRect);
  });

  test("applies a gradient background with padding", async ({ context, extensionId }) => {
    const id = await seedCapture(context, await makeImageDataUrl(context));
    const page = await openEditor(context, extensionId, id);
    const w0 = await page.evaluate(() => window.Konva.stages[0].width());
    await page.selectOption("#prop-bgtype", "gradient");
    await page.locator("#prop-pad").evaluate((el) => { el.value = "40"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForTimeout(150);
    const w1 = await page.evaluate(() => window.Konva.stages[0].width());
    expect(w1).toBe(w0 + 80); // padding added on both sides
  });
});
