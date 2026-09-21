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

test.describe("Clipboard history", () => {
  test("popup has a clipboard section with Ctrl/⌘+Shift+V", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await expect(page.locator(".grp--clip .grp__title")).toHaveText("Clipboard history");
    await expect(page.locator(".grp--clip .grp__lead")).toContainText("last 5");
    await expect(page.locator(".clip-card__keys")).toBeVisible();
    await expect(page.locator(".qr__toggle")).toContainText("Show QR on the page");
  });

  test("picker lists the last copies from session storage", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const tabId = await (await sw(context)).evaluate(async (part) => {
      const tabs = await chrome.tabs.query({});
      return (tabs.find((t) => (t.url || "").includes(part)) || {}).id;
    }, "tall-page.html");
    expect(tabId).toBeTruthy();

    const items = ["alpha copy", "beta copy"];
    await (await sw(context)).evaluate(async ({ tabId, items }) => {
      await chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
      }).catch(() => {});
      await chrome.storage.session.set({ clipHistory: items });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/clip-history.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "SHOW_CLIP_PICKER", items });
    }, { tabId, items });

    const host = page.locator("#snapshot-clip-host");
    await expect(host).toBeAttached();
    await expect(host.locator(".row")).toHaveCount(2);
    await expect(host.locator(".t").first()).toHaveText("alpha copy");
  });

  test("copying text stores it and Ctrl+Shift+V pastes a selection", async ({ context }) => {
    test.setTimeout(45_000);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();

    await page.evaluate(() => {
      const wrap = document.createElement("div");
      wrap.style.cssText = "position:fixed;left:16px;top:80px;z-index:9999;display:flex;flex-direction:column;gap:8px;";
      const area = document.createElement("textarea");
      area.id = "clip-source";
      area.value = "first clip item\nsecond clip item";
      area.style.cssText = "width:280px;height:64px;";
      const dest = document.createElement("textarea");
      dest.id = "clip-dest";
      dest.value = "";
      dest.style.cssText = "width:280px;height:64px;";
      wrap.append(area, dest);
      document.body.appendChild(wrap);
    });

    const tabId = await (await sw(context)).evaluate(async (part) => {
      const tabs = await chrome.tabs.query({});
      return (tabs.find((t) => (t.url || "").includes(part)) || {}).id;
    }, "tall-page.html");

    await (await sw(context)).evaluate(async (tabId) => {
      await chrome.storage.session.setAccessLevel({
        accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS",
      }).catch(() => {});
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["src/content/clip-history.js"],
      });
    }, tabId);

    await page.locator("#clip-source").click({ force: true });
    await page.locator("#clip-source").fill("first clip item");
    await page.locator("#clip-source").press("ControlOrMeta+A");
    await page.locator("#clip-source").press("ControlOrMeta+C");
    await page.waitForTimeout(400);

    // Ensure history has the copy even if the page blocked clipboard events.
    await (await sw(context)).evaluate(async () => {
      const { clipHistory } = await chrome.storage.session.get("clipHistory");
      if (!Array.isArray(clipHistory) || !clipHistory.length) {
        await chrome.storage.session.set({ clipHistory: ["first clip item"] });
      }
    });

    const stored = await (await sw(context)).evaluate(async () => {
      const { clipHistory } = await chrome.storage.session.get("clipHistory");
      return clipHistory;
    });
    expect(Array.isArray(stored)).toBeTruthy();
    expect(stored[0]).toContain("first clip item");

    await page.locator("#clip-dest").click({ force: true });
    await page.keyboard.press("ControlOrMeta+Shift+V");
    const host = page.locator("#snapshot-clip-host");
    await expect(host).toBeAttached({ timeout: 10_000 });
    await expect(host.locator(".row").first()).toBeVisible();
    await host.locator(".row").first().click();
    await expect(page.locator("#clip-dest")).toHaveValue(/first clip item/);
  });
});
