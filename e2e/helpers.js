// Shared helpers for the E2E specs.
const fs = require("node:fs");
const path = require("node:path");

// Seed a capture into chrome.storage.local (as the service worker does) so the
// editor can be opened with ?id=… exactly like a real capture.
async function seedCapture(context, dataUrl, meta = {}) {
  const id = "e2e" + Math.random().toString(36).slice(2, 8);
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  await sw.evaluate(
    async ([key, payload]) => { await chrome.storage.local.set({ [key]: payload }); },
    ["capture:" + id, { dataUrl, meta, createdAt: Date.now() }]
  );
  return id;
}

// Open the editor for a seeded capture and wait until the Konva stage exists.
async function openEditor(context, extensionId, id) {
  const page = await context.newPage();
  const url = `chrome-extension://${extensionId}/src/editor/editor.html` + (id ? `?id=${id}` : "");
  await page.goto(url);
  await page.waitForFunction(() => window.Konva && window.Konva.stages && window.Konva.stages.length > 0, null, { timeout: 30_000 });
  return page;
}

// Install spies over chrome.downloads.download and clipboard so exports can be
// asserted deterministically without touching the real filesystem/clipboard.
async function installExportSpies(page) {
  await page.evaluate(() => {
    window.__downloads = [];
    if (chrome?.downloads?.download) {
      chrome.downloads.download = (opts) => { window.__downloads.push(opts); return Promise.resolve(1); };
    }
    window.__clipboard = [];
    // Image clipboard
    navigator.clipboard.write = async (items) => { window.__clipboard.push({ kind: "image", items: items.length }); };
    // Text clipboard
    const origText = navigator.clipboard.writeText?.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (t) => { window.__clipboard.push({ kind: "text", text: t }); if (origText) try { await origText(t); } catch (_) {} };
  });
}

// Generate a real-sized PNG data URL in the browser (canvas). Optionally draw
// dark text on it — used for OCR fixtures.
async function makeImageDataUrl(context, { w = 400, h = 300, bg = "#4477aa", text = "", textColor = "#000000" } = {}) {
  const page = await context.newPage();
  await page.goto("data:text/html,<body></body>");
  const url = await page.evaluate(({ w, h, bg, text, textColor }) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    if (text) {
      x.fillStyle = textColor;
      x.font = "bold 52px Arial, sans-serif";
      x.textBaseline = "top";
      x.fillText(text, 24, Math.round(h / 2) - 26);
    }
    return c.toDataURL("image/png");
  }, { w, h, bg, text, textColor });
  await page.close();
  return url;
}

// A tiny solid-colour PNG data URL (used where image content doesn't matter).
function solidPngDataUrl() {
  // 2x2 red PNG
  return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP8z8Dwn4EIwDiqEAAxYwMHKZThQwAAAABJRU5ErkJggg==";
}

// Read a committed asset (e.g. the QR fixture) as a data URL.
function fileDataUrl(relPath, mime = "image/png") {
  const buf = fs.readFileSync(path.join(__dirname, relPath));
  return `data:${mime};base64,` + buf.toString("base64");
}

module.exports = { seedCapture, openEditor, installExportSpies, makeImageDataUrl, solidPngDataUrl, fileDataUrl };
