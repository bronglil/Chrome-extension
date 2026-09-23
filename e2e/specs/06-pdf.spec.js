const { test, expect } = require("../fixtures.js");
const path = require("node:path");
const fs = require("node:fs");

const SAMPLE = path.join(__dirname, "..", "assets", "sample.pdf");
const TOL = 10; // px — mouse sampling + subpixel rounding

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

/** Stage-space polyline → mouse drag that must land on those exact stage coords. */
async function dragOnStage(page, tool, stagePoints) {
  await page.click(`.rail__tool[data-tool="${tool}"]`);
  await expect(page.locator(`.rail__tool[data-tool="${tool}"]`)).toHaveClass(/is-active/);

  const clients = await page.evaluate((pts) => {
    return pts.map(([x, y]) => window.__pdfEditor.clientFromStage(x, y));
  }, stagePoints);
  expect(clients.every((c) => c && Number.isFinite(c.x) && Number.isFinite(c.y))).toBe(true);

  await page.mouse.move(clients[0].x, clients[0].y);
  await page.mouse.down();
  for (let i = 1; i < clients.length; i++) {
    await page.mouse.move(clients[i].x, clients[i].y, { steps: 4 });
  }
  await page.mouse.up();
  return clients;
}

function near(actual, expected, tol = TOL) {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tol);
}

test.describe("PDF editor", () => {
  test("opens a PDF and reports the page count", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    const n = await page.evaluate(() => window.__pdfEditor.state.numPages);
    expect(n).toBe(2);
    await expect(page.locator(".pe-page")).toHaveCount(2);
    await expect(page.locator("#pe-empty")).toBeHidden();
  });

  test("navigates between pages", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.evaluate(() => window.__pdfEditor.goToPage(2));
    await expect(page.locator("#pe-pageinfo")).toHaveText("2 / 2");
    await page.evaluate(() => window.__pdfEditor.goToPage(1));
    await expect(page.locator("#pe-pageinfo")).toHaveText("1 / 2");
  });

  test("pen stroke points match the mouse path on the page", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);

    const pathPts = [
      [80, 120],
      [160, 150],
      [240, 130],
      [320, 180],
    ];
    await dragOnStage(page, "pen", pathPts);
    expect(await overlayCount(page, ".pen")).toBe(1);

    const got = await page.evaluate(() => {
      const line = window.__pdfEditor.state.overlayLayer.findOne(".pen");
      return { points: line.points(), stroke: line.stroke(), width: line.strokeWidth() };
    });
    expect(got.points.length).toBeGreaterThanOrEqual(pathPts.length * 2);
    near(got.points[0], pathPts[0][0]);
    near(got.points[1], pathPts[0][1]);
    near(got.points[got.points.length - 2], pathPts[pathPts.length - 1][0]);
    near(got.points[got.points.length - 1], pathPts[pathPts.length - 1][1]);
    // Every planned waypoint must appear somewhere along the sampled polyline.
    for (const [ex, ey] of pathPts) {
      let best = Infinity;
      for (let i = 0; i < got.points.length; i += 2) {
        const d = Math.hypot(got.points[i] - ex, got.points[i + 1] - ey);
        if (d < best) best = d;
      }
      expect(best).toBeLessThanOrEqual(18);
    }
    expect(got.width).toBeGreaterThan(0);
  });

  test("highlighter stroke lands on the dragged line of text", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);

    const pathPts = [
      [60, 80],
      [180, 80],
      [300, 80],
      [360, 80],
    ];
    await dragOnStage(page, "highlight", pathPts);
    expect(await overlayCount(page, ".highlight")).toBe(1);

    const got = await page.evaluate(() => {
      const line = window.__pdfEditor.state.overlayLayer.findOne(".highlight");
      return {
        points: line.points(),
        gco: line.globalCompositeOperation(),
        opacity: line.opacity(),
      };
    });
    near(got.points[0], pathPts[0][0]);
    near(got.points[1], pathPts[0][1]);
    near(got.points[got.points.length - 2], pathPts[pathPts.length - 1][0]);
    near(got.points[got.points.length - 1], pathPts[pathPts.length - 1][1]);
    for (let i = 1; i < got.points.length; i += 2) {
      near(got.points[i], 80, 14);
    }
    expect(got.gco).toBe("multiply");
    expect(got.opacity).toBeLessThan(1);
  });

  test("two separate pen lines keep independent positions", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);

    await dragOnStage(page, "pen", [
      [70, 90],
      [200, 90],
    ]);
    await dragOnStage(page, "pen", [
      [70, 200],
      [200, 220],
    ]);
    expect(await overlayCount(page, ".pen")).toBe(2);

    const lines = await page.evaluate(() =>
      window.__pdfEditor.state.overlayLayer.find(".pen").map((l) => l.points())
    );
    near(lines[0][1], 90);
    near(lines[1][1], 200);
    near(lines[0][0], 70);
    near(lines[1][0], 70);
  });

  test("pen color and weight apply to the stroke that was drawn", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.fill("#pe-color", "#dc2626");
    await page.fill("#pe-stroke", "7");
    await dragOnStage(page, "pen", [
      [100, 140],
      [220, 160],
    ]);
    const style = await page.evaluate(() => {
      const line = window.__pdfEditor.state.overlayLayer.findOne(".pen");
      return { stroke: line.stroke(), width: line.strokeWidth() };
    });
    expect(style.stroke.toLowerCase()).toBe("#dc2626");
    expect(style.width).toBe(7);
  });

  test("text is created at the click coordinates", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="text"]');

    const target = { x: 140, y: 110 };
    const client = await page.evaluate(
      ({ x, y }) => window.__pdfEditor.clientFromStage(x, y),
      target
    );
    await page.mouse.click(client.x, client.y);
    const inline = page.locator("textarea.text-inline");
    await expect(inline).toBeVisible({ timeout: 10_000 });
    await inline.fill("Hello PDF");
    await inline.press("Enter");

    const pos = await page.evaluate(() => {
      const t = window.__pdfEditor.state.overlayLayer.find("Text").find((n) => n.text() === "Hello PDF");
      return t ? { x: t.x(), y: t.y(), text: t.text() } : null;
    });
    expect(pos).toBeTruthy();
    near(pos.x, target.x);
    near(pos.y, target.y);
  });

  test("adds text and lets you edit it afterwards", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="text"]');
    const target = { x: 140, y: 110 };
    const client = await page.evaluate(
      ({ x, y }) => window.__pdfEditor.clientFromStage(x, y),
      target
    );
    await page.mouse.click(client.x, client.y);
    const inline = page.locator("textarea.text-inline");
    await expect(inline).toBeVisible({ timeout: 10_000 });
    await inline.fill("Hello PDF");
    await inline.press("Enter");
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.overlayLayer.find("Text").map((t) => t.text())
    )).toContain("Hello PDF");
    await expect(page.locator("#pe-text-panel")).toBeVisible();
    await page.fill("#pe-text-value", "Edited later");
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.overlayLayer.find("Text").some((t) => t.text() === "Edited later")
    )).toBe(true);
  });

  test("drawn signature pad ink places a sig image on the page", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="sign"]');
    await expect(page.locator("#pe-sig-modal")).toBeVisible();
    await page.click('.seg__btn[data-sig="draw"]');
    const pad = page.locator("#pe-sigpad");
    await expect(pad).toBeVisible();
    const box = await pad.boundingBox();
    expect(box).toBeTruthy();
    await page.mouse.move(box.x + 30, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 50, { steps: 6 });
    await page.mouse.move(box.x + 180, box.y + 70, { steps: 6 });
    await page.mouse.up();
    await page.click("#pe-sig-add");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);
    const placed = await page.evaluate(() => {
      const n = window.__pdfEditor.state.overlayLayer.findOne(".sig");
      const W = window.__pdfEditor.state.stage.width();
      const H = window.__pdfEditor.state.stage.height();
      return { x: n.x(), y: n.y(), w: n.width(), h: n.height(), W, H };
    });
    near(placed.x + placed.w / 2, placed.W / 2, 20);
    near(placed.y + placed.h / 2, placed.H / 2, 20);
  });

  test("places a typed signature onto the page", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="sign"]');
    await expect(page.locator("#pe-sig-modal")).toBeVisible();
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.overlayLayer.find(".sig").length
    )).toBe(1);
  });

  test("signature persists across page navigation", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('.rail__tool[data-tool="sign"]');
    await page.click('.seg__btn[data-sig="type"]');
    await page.fill("#pe-sig-text", "Sajid");
    await page.click("#pe-sig-add");
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);
    await page.evaluate(() => window.__pdfEditor.goToPage(2));
    await expect.poll(() => overlayCount(page, ".sig")).toBe(0);
    await page.evaluate(() => window.__pdfEditor.goToPage(1));
    await expect.poll(() => overlayCount(page, ".sig")).toBe(1);
  });

  test("Acknowledge stamps an AK mark and persists across pages", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click("#pe-ack");
    await expect(page.locator("#pe-ack")).toHaveClass(/is-active/);
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.ackLayer.getChildren().length
    )).toBeGreaterThan(0);
    await page.evaluate(() => window.__pdfEditor.goToPage(2));
    await expect.poll(() => page.evaluate(
      () => window.__pdfEditor.state.ackLayer.getChildren().length
    )).toBeGreaterThan(0);
  });

  test("Acknowledge avoids overwriting: picks the free bottom corner", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    const sides = await page.evaluate(() => {
      const mk = (paint) => {
        const c = document.createElement("canvas");
        c.width = 600; c.height = 400;
        const x = c.getContext("2d");
        x.fillStyle = "#fff"; x.fillRect(0, 0, 600, 400);
        paint(x);
        return c;
      };
      const pick = window.__pdfEditor.chooseAckSide;
      const blank = mk(() => {});
      const rightBusy = mk((x) => { x.fillStyle = "#000"; x.fillRect(430, 360, 150, 30); });
      const leftBusy = mk((x) => { x.fillStyle = "#000"; x.fillRect(10, 360, 150, 30); });
      return { blank: pick(blank), rightBusy: pick(rightBusy), leftBusy: pick(leftBusy) };
    });
    expect(sides.blank).toBe("right");
    expect(sides.rightBusy).toBe("left");
    expect(sides.leftBusy).toBe("right");
  });

  test("delete removes the selected pen stroke", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await dragOnStage(page, "pen", [
      [90, 100],
      [180, 120],
    ]);
    expect(await overlayCount(page, ".pen")).toBe(1);
    await page.click('.rail__tool[data-tool="select"]');
    await page.evaluate(() => {
      const line = window.__pdfEditor.state.overlayLayer.findOne(".pen");
      window.__pdfEditor.state.transformer.nodes([line]);
    });
    await page.click("#pe-delete");
    await expect.poll(() => overlayCount(page, ".pen")).toBe(0);
  });

  test("exports PDF with pen + highlight still larger than original", async ({ context, extensionId }) => {
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await dragOnStage(page, "pen", [
      [80, 100],
      [250, 140],
    ]);
    await dragOnStage(page, "highlight", [
      [60, 200],
      [300, 200],
    ]);
    expect(await overlayCount(page, ".pen")).toBe(1);
    expect(await overlayCount(page, ".highlight")).toBe(1);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.click("#pe-save"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const outPath = await download.path();
    const bytes = fs.readFileSync(outPath);
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(fs.statSync(SAMPLE).size);
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
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const outPath = await download.path();
    const bytes = fs.readFileSync(outPath);
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(fs.statSync(SAMPLE).size);
  });

  test("rotates the current page 90° and swaps stage dimensions", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);

    const before = await page.evaluate(() => {
      const s = window.__pdfEditor.state;
      return {
        w: s.stage.width(),
        h: s.stage.height(),
        rot: window.__pdfEditor.userRotation(s.pageNum),
      };
    });
    expect(before.rot).toBe(0);

    await page.click("#pe-rotate-cw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/90°/, { timeout: 15_000 });

    const after = await page.evaluate(() => {
      const s = window.__pdfEditor.state;
      return {
        w: s.stage.width(),
        h: s.stage.height(),
        rot: window.__pdfEditor.userRotation(s.pageNum),
        size: s.pageSizes[s.pageNum],
      };
    });
    expect(after.rot).toBe(90);
    // Fit-to-width means sizes aren't a pure swap — aspect must invert.
    expect(before.w / before.h).toBeLessThan(1.05); // sample page is portrait-ish
    expect(after.w / after.h).toBeGreaterThan(1);
    expect(after.size.rotation % 360).toBe(90);

    await page.click("#pe-rotate-cw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/180°/);
    await page.click("#pe-rotate-ccw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/90°/);
    await page.click("#pe-rotate-ccw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/0°/);
  });

  test("All pages scope rotates every page together", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);

    await page.click('#pe-rotate-scope [data-rotate-scope="all"]');
    await expect(page.locator('#pe-rotate-scope [data-rotate-scope="all"]')).toHaveClass(/is-active/);

    await page.click("#pe-rotate-cw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/90°.*all pages/i, { timeout: 15_000 });

    const rots = await page.evaluate(() => {
      const n = window.__pdfEditor.state.numPages;
      return Array.from({ length: n }, (_, i) => window.__pdfEditor.userRotation(i + 1));
    });
    expect(rots).toEqual([90, 90]);

    // Page 2 slot should also be landscape now.
    const sizes = await page.evaluate(() => {
      const s = window.__pdfEditor.state.pageSizes;
      return { p1: s[1], p2: s[2] };
    });
    expect(sizes.p1.w).toBeGreaterThan(sizes.p1.h);
    expect(sizes.p2.w).toBeGreaterThan(sizes.p2.h);
  });

  test("rotate clears annotations on that page then export still works", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const page = await openPdfEditor(context, extensionId);
    await loadSample(page);
    await page.click('#pe-rotate-scope [data-rotate-scope="page"]');
    await dragOnStage(page, "pen", [
      [80, 100],
      [200, 120],
    ]);
    expect(await overlayCount(page, ".pen")).toBe(1);

    await page.click("#pe-rotate-cw");
    await expect(page.locator("#pe-rotate-label")).toHaveText(/90°/, { timeout: 15_000 });
    await expect.poll(() => overlayCount(page, ".pen")).toBe(0);

    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30_000 }),
      page.click("#pe-save"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const bytes = fs.readFileSync(await download.path());
    expect(bytes.slice(0, 5).toString()).toBe("%PDF-");
  });
});
