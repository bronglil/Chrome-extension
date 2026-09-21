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
  test("popup mentions Ctrl/⌘+Shift+V", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await expect(page.locator(".grp__lead").filter({ hasText: "last 5" })).toBeVisible();
  });

  test("picker lists the last copies from session storage", async ({ context }) => {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/tall-page.html`);
    await page.bringToFront();
    const tabId = await (await sw(context)).evaluate(async (part) => {
      const tabs = await chrome.tabs.query({});
      return (tabs.find((t) => (t.url || "").includes(part)) || {}).id;
    }, "tall-page.html");

    await (await sw(context)).evaluate(async (tabId) => {
      await chrome.storage.session.set({ clipHistory: ["alpha copy", "beta copy"] });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["src/content/clip-history.js"],
      });
      await chrome.tabs.sendMessage(tabId, { type: "SHOW_CLIP_PICKER" });
    }, tabId);

    await expect(page.locator("#snapshot-clip-host")).toBeAttached();
    await expect(page.locator("#snapshot-clip-host .row")).toHaveCount(2);
    await expect(page.locator("#snapshot-clip-host .t").first()).toHaveText("alpha copy");
  });
});
