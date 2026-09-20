// ============================================================================
// SnapShot Studio — Service Worker (MV3 background)
//
// The service worker is the router. It cannot touch the DOM or media APIs, so
// all real media work is delegated:
//   * chrome.tabs.captureVisibleTab  -> visible / area / full-page (no picker)
//   * chrome.desktopCapture          -> stream IDs for screen/window/recording
//   * an offscreen document          -> getUserMedia frame grabs + MediaRecorder
//   * a content script               -> in-page overlay + scroll-and-stitch
//
// Captured images stay in memory for a one-shot handoff to the editor.
// They are never written to chrome.storage.local (that quota is ~10 MB).
// ============================================================================

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

// In-memory recording state (mirrored to storage so the popup survives worker
// restarts). The actual MediaRecorder lives in the offscreen document.
let recording = { active: false, startedAt: 0, windowId: 0 };

// ---------------------------------------------------------------------------
// Offscreen document lifecycle
// ---------------------------------------------------------------------------
async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    return ctxs.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "BLOBS"],
    justification:
      "Capture screen frames, record the screen, run OCR, and stitch images.",
  });
}

// Send a message to the offscreen document and await its reply.
async function toOffscreen(message) {
  await ensureOffscreen();
  return chrome.runtime.sendMessage({ ...message, target: "offscreen" });
}

// ---------------------------------------------------------------------------
// Image storage + editor
// ---------------------------------------------------------------------------
function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function pageMeta(tab, extra = {}) {
  return {
    url: tab?.url || "",
    title: tab?.title || "",
    favIconUrl: tab?.favIconUrl || "",
    ...extra,
  };
}

const pendingCaptures = new Map();

async function clearDiskCaptures() {
  try {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("capture:") || k.startsWith("ocr:"));
    if (keys.length) await chrome.storage.local.remove(keys);
  } catch (_) { /* ignore */ }
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase("snapshot-captures");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  } catch (_) { /* nothing to wipe */ }
}

async function stashAndOpenEditor(dataUrl, meta = {}) {
  const id = shortId();
  pendingCaptures.set(id, { dataUrl, meta, createdAt: Date.now() });
  setTimeout(() => pendingCaptures.delete(id), 120000);
  await clearDiskCaptures().catch(() => {});
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/editor/editor.html") + "?id=" + id,
  });
  return id;
}

function takeCapture(id) {
  const payload = pendingCaptures.get(id) || null;
  if (payload) pendingCaptures.delete(id);
  return payload;
}

async function openEmptyEditor() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/editor/editor.html"),
  });
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------
function isRestricted(url = "") {
  return (
    !url ||
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("chrome-search://") ||
    url.startsWith("devtools://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("https://chromewebstore.google.com") ||
    url.startsWith("about:")
  );
}

function isCapturable(tab) {
  return !!(tab && tab.id && !isRestricted(tab.url) && /^https?:/i.test(tab.url));
}

async function getActiveTab() {
  // Prefer a normal browser window — the toolbar popup is its own window, and
  // opening popup.html as a tab would otherwise make *that* the "active" tab.
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const focused = wins.find((w) => w.focused) || wins[0];
  const active = focused?.tabs?.find((t) => t.active);
  if (active) return active;
  const [fallback] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return fallback;
}

async function getCaptureTab() {
  const active = await getActiveTab();
  if (isCapturable(active)) return active;

  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  for (const win of [wins.find((w) => w.id === active?.windowId), ...wins].filter(Boolean)) {
    const page = (win.tabs || []).find(isCapturable);
    if (page) {
      await chrome.tabs.update(page.id, { active: true });
      await chrome.windows.update(page.windowId, { focused: true });
      return page;
    }
  }
  throw new Error(
    "Open a regular website first (https://…). Chrome pages and the extension itself can't be captured."
  );
}

let jobBusy = false;
let queuedJob = null;
let lastJobAt = 0;
async function consumePendingJob(job) {
  if (!job) return;
  if (job.at && job.at === lastJobAt) return;
  if (jobBusy) {
    queuedJob = job;
    return;
  }
  jobBusy = true;
  lastJobAt = job.at || Date.now();
  try {
    await ensureOffscreen().catch(() => {});
    await chrome.storage.session.remove("pendingJob");
    if (job.type === "RECORD") {
      await toggleRecording(job.options || {});
    } else if (job.type === "CAPTURE") {
      if (job.delayMs) await new Promise((r) => setTimeout(r, job.delayMs));
      await runCapture(job.action);
    }
  } catch (err) {
    console.error("[SnapShot SW] job", err);
    showPageError(friendlyError(err));
  } finally {
    jobBusy = false;
    const next = queuedJob;
    queuedJob = null;
    if (next) consumePendingJob(next);
  }
}

async function showPageError(message) {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || isRestricted(tab.url)) return;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (text) => {
        document.querySelector(".snapshot-error")?.remove();
        const el = document.createElement("div");
        el.className = "snapshot-error";
        el.textContent = text;
        Object.assign(el.style, {
          position: "fixed",
          top: "16px",
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: "2147483647",
          background: "#111827",
          color: "#fff",
          padding: "10px 14px",
          borderRadius: "10px",
          font: "13px/1.4 -apple-system, Segoe UI, sans-serif",
          boxShadow: "0 10px 24px rgba(0,0,0,.3)",
          maxWidth: "90vw",
        });
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 5200);
      },
      args: [message],
    });
  } catch (_) { /* no page to tell */ }
}

chrome.storage.session.onChanged.addListener((changes) => {
  if (changes.pendingJob?.newValue) consumePendingJob(changes.pendingJob.newValue);
});
chrome.storage.session.get("pendingJob").then((s) => {
  if (s.pendingJob) consumePendingJob(s.pendingJob);
});

function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/respective host|Cannot access contents of the page/i.test(msg)) {
    return "Can't access this page. Open a normal website, then in chrome://extensions set SnapShot Studio → Site access → On all sites.";
  }
  if (/cancell|NotAllowed|denied|abort/i.test(msg)) {
    return "Share was closed before anything was picked. Try again and click Share in Chrome’s dialog.";
  }
  if (/quota/i.test(msg)) {
    return "Storage was full from old screenshots. They were cleared — try the capture again.";
  }
  return msg;
}

// ---------------------------------------------------------------------------
// On-page QR overlay (opt-in). Registered as a dynamic content script only
// while enabled, so there is zero footprint on pages when it's off.
// ---------------------------------------------------------------------------
const PAGE_QR_SCRIPT = {
  id: "pageqr",
  matches: ["<all_urls>"],
  js: ["vendor/qrcode-generator.min.js", "src/content/qr-overlay.js"],
  runAt: "document_idle",
};

async function pageQrRegistered() {
  try {
    const r = await chrome.scripting.getRegisteredContentScripts({ ids: ["pageqr"] });
    return r.length > 0;
  } catch (_) { return false; }
}

async function setPageQr(on) {
  await chrome.storage.local.set({ pageQrEnabled: on });
  try {
    const registered = await pageQrRegistered();
    if (on && !registered) await chrome.scripting.registerContentScripts([PAGE_QR_SCRIPT]);
    if (!on && registered) await chrome.scripting.unregisterContentScripts({ ids: ["pageqr"] });
  } catch (e) { console.warn("[SnapShot] pageqr register", e); }

  // Reflect immediately on a real webpage, never on chrome:// or the popup.
  const tab = await getActiveTab();
  if (isCapturable(tab)) {
    if (on) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: PAGE_QR_SCRIPT.js }).catch(() => {});
    } else {
      chrome.tabs.sendMessage(tab.id, { type: "PAGE_QR_HIDE" }).catch(() => {});
    }
  }
  return { on };
}

// Keep the dynamic registration in sync with the stored preference.
const CLIP_KEY = "clipHistory";
const CLIP_MAX = 5;
const CLIP_SCRIPT = {
  id: "cliphist",
  matches: ["<all_urls>"],
  js: ["src/content/clip-history.js"],
  runAt: "document_idle",
};

async function rememberClip(text) {
  const t = String(text || "").trim();
  if (!t) return;
  const clipped = t.length > 8000 ? t.slice(0, 8000) : t;
  const { clipHistory } = await chrome.storage.session.get(CLIP_KEY);
  const list = Array.isArray(clipHistory) ? clipHistory : [];
  await chrome.storage.session.set({
    [CLIP_KEY]: [clipped, ...list.filter((x) => x !== clipped)].slice(0, CLIP_MAX),
  });
}

async function syncClipHistory() {
  try {
    const r = await chrome.scripting.getRegisteredContentScripts({ ids: ["cliphist"] });
    if (!r.length) await chrome.scripting.registerContentScripts([CLIP_SCRIPT]);
  } catch (e) { console.warn("[SnapShot] cliphist", e); }
}

async function showClipPicker() {
  const tab = await getActiveTab();
  if (!isCapturable(tab)) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_CLIP_PICKER" });
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: CLIP_SCRIPT.js,
    });
    await chrome.tabs.sendMessage(tab.id, { type: "SHOW_CLIP_PICKER" }).catch(() => {});
  }
}

async function syncPageQr() {
  const { pageQrEnabled } = await chrome.storage.local.get("pageQrEnabled");
  const registered = await pageQrRegistered();
  try {
    if (pageQrEnabled && !registered) await chrome.scripting.registerContentScripts([PAGE_QR_SCRIPT]);
    if (!pageQrEnabled && registered) await chrome.scripting.unregisterContentScripts({ ids: ["pageqr"] });
  } catch (e) { console.warn("[SnapShot] pageqr sync", e); }
}

// captureVisibleTab is rate-limited to ~2/sec; callers that loop must throttle.
// It can also transiently fail with "image readback failed" (e.g. right after a
// tab switch, or on GPU-less/headless compositors), so retry a few times.
async function captureVisible(windowId) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// Make sure the content script is present, then message it.
async function ensureContentScript(tabId) {
  let api = 0;
  try {
    const [inj] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.__snapshotStudioApi || 0,
    });
    api = inj?.result || 0;
  } catch (_) { /* restricted page or not injected yet */ }
  if (api >= 4) return;
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["src/content/area-select.css"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/lib/utils.js", "src/content/content.js"],
  });
}

// ---------------------------------------------------------------------------
// Capture actions
// ---------------------------------------------------------------------------
async function captureVisibleArea() {
  const tab = await getCaptureTab();
  const dataUrl = await captureVisible(tab.windowId);
  await stashAndOpenEditor(dataUrl, pageMeta(tab, { kind: "visible" }));
}

async function captureArea() {
  const tab = await getCaptureTab();
  await ensureContentScript(tab.id);
  // The content script shows the overlay, returns the selected rectangle
  // (already scaled by devicePixelRatio) or null if cancelled.
  const rect = await chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECT" });
  if (!rect) return; // cancelled
  const dataUrl = await captureVisible(tab.windowId);
  await stashAndOpenEditor(dataUrl, pageMeta(tab, { kind: "area", cropRect: rect }));
}

async function captureFullPage() {
  const tab = await getCaptureTab();
  await ensureContentScript(tab.id);
  // The content script drives scroll-and-stitch, calling back to CAPTURE_SLICE
  // for each viewport (which we service with captureVisibleTab, throttled).
  const result = await chrome.tabs.sendMessage(tab.id, { type: "START_FULL_PAGE" });
  if (!result || result.error) throw new Error(result?.error || "Full-page capture failed.");
  await stashAndOpenEditor(result.dataUrl, pageMeta(tab, {
    kind: "fullpage",
    width: result.width,
    height: result.height,
    tiles: result.tiles || 1,
  }));
}

async function ocrArea() {
  const tab = await getCaptureTab();
  await ensureContentScript(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "START_COPY_TEXT" });
  if (!result || result.cancelled) return;
  const rect = result.deviceRect;
  if (!rect) return;

  const dataUrl = await captureVisible(tab.windowId);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "COPY_TEXT_CAPTURED" });
  } catch (_) { /* overlay gone */ }

  const res = await toOffscreen({ type: "OCR_CROP", dataUrl, rect });
  const text = String(res?.text || "").trim() || String(result.domText || "").trim();
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "FILL_COPY_TEXT",
      text,
      error: text ? "" : (res?.error || "No text found in this area."),
    });
  } catch (_) { /* overlay already closed */ }
}

// Desktop still: a small page owns getDisplayMedia so Chrome's share
// dialog is not cancelled when the extension popup closes.
async function captureDesktop(kind) {
  const prefix = chrome.runtime.getURL("src/capture/desktop.html");
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find((t) => (t.url || "").startsWith(prefix));
  const url = prefix + "?kind=" + encodeURIComponent(kind);
  if (existing) {
    await chrome.tabs.update(existing.id, { url });
    await chrome.windows.update(existing.windowId, { focused: true });
    return;
  }
  await chrome.windows.create({
    url,
    type: "popup",
    width: 380,
    height: 280,
    focused: true,
  });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function findRecorderTab() {
  const prefix = chrome.runtime.getURL("src/recorder/recorder.html");
  const isRecorder = (t) => (t.url || "").startsWith(prefix);
  if (recording.windowId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: recording.windowId });
      const hit = tabs.find(isRecorder);
      if (hit) return hit;
    } catch (_) { /* window already gone */ }
  }
  const tabs = await chrome.tabs.query({});
  return tabs.find(isRecorder) || null;
}

async function focusRecorder(tab) {
  recording = {
    active: true,
    pending: !recording.startedAt,
    startedAt: recording.startedAt || 0,
    windowId: tab.windowId,
  };
  await chrome.storage.local.set({ recordingState: recording });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { recording: true, pending: !!recording.pending, startedAt: recording.startedAt };
}

async function toggleRecording(options = {}) {
  const existing = await findRecorderTab();
  const live = !!(recording.active && recording.startedAt && !recording.pending);

  if (live) {
    chrome.runtime.sendMessage({ type: "RECORDER_STOP" }).catch(() => {});
    return { recording: true, stopping: true, startedAt: recording.startedAt };
  }

  if (existing) return focusRecorder(existing);

  const qs = new URLSearchParams({
    cam: options.camera ? "1" : "0",
    mic: options.mic ? "1" : "0",
    audio: options.systemAudio ? "1" : "0",
  });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("src/recorder/recorder.html") + "?" + qs.toString(),
    type: "popup",
    width: 420,
    height: 620,
    focused: true,
  });
  recording = { active: true, startedAt: 0, pending: true, windowId: win.id };
  await chrome.storage.local.set({ recordingState: recording });
  return { recording: true, pending: true };
}

async function markRecordingStarted(startedAt) {
  recording = {
    active: true,
    startedAt: startedAt || Date.now(),
    pending: false,
    windowId: recording.windowId || 0,
  };
  await chrome.storage.local.set({ recordingState: recording });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  chrome.action.setBadgeText({ text: "●" });
}

async function markRecordingIdle() {
  recording = { active: false, startedAt: 0 };
  await chrome.storage.local.set({ recordingState: recording });
  chrome.action.setBadgeText({ text: "" });
}

// ---------------------------------------------------------------------------
// Delayed capture
// ---------------------------------------------------------------------------
function runCapture(action) {
  switch (action) {
    case "capture-visible": return captureVisibleArea();
    case "capture-area": return captureArea();
    case "capture-full-page": return captureFullPage();
    case "capture-fullscreen": return captureDesktop("screen");
    case "capture-window": return captureDesktop("window");
    case "ocr-area": return ocrArea();
    default: return Promise.reject(new Error("Unknown action: " + action));
  }
}

// ---------------------------------------------------------------------------
// Message router (popup, offscreen, editor, content)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages addressed to the offscreen document.
  if (msg?.target === "offscreen") return false;
  if (msg?.type === "RECORDER_STOP") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "CAPTURE": {
          if (msg.delayMs) {
            // Timer lives in the (event) service worker; it may be suspended,
            // but chrome keeps it alive while an async response is pending here.
            await new Promise((r) => setTimeout(r, msg.delayMs));
          }
          await runCapture(msg.action);
          sendResponse({ ok: true });
          break;
        }
        case "TOGGLE_RECORDING":
          sendResponse(await toggleRecording(msg.options || {}));
          break;
        case "GET_RECORDING_STATE":
          sendResponse({ recording: recording.active, startedAt: recording.startedAt, pending: !!recording.pending });
          break;
        case "RECORDING_STARTED":
          await markRecordingStarted(msg.startedAt);
          sendResponse({ ok: true });
          break;
        case "CLIP_REMEMBER":
          await rememberClip(msg.text);
          sendResponse({ ok: true });
          break;
        case "TAKE_CAPTURE":
          sendResponse(takeCapture(msg.id) || {});
          break;
        case "DESKTOP_FRAME": {
          if (!msg.dataUrl) throw new Error("No screenshot received.");
          await stashAndOpenEditor(msg.dataUrl, { kind: msg.kind || "desktop-screen" });
          sendResponse({ ok: true });
          break;
        }
        case "RECORDING_CANCELLED":
          await markRecordingIdle();
          sendResponse({ ok: true });
          break;
        case "OPEN_EDITOR":
          await openEmptyEditor();
          sendResponse({ ok: true });
          break;
        case "GET_PAGE_QR": {
          const { pageQrEnabled } = await chrome.storage.local.get("pageQrEnabled");
          sendResponse({ on: !!pageQrEnabled });
          break;
        }
        case "SET_PAGE_QR":
          sendResponse(await setPageQr(!!msg.on));
          break;
        case "CAPTURE_SLICE": {
          // Requested by the content script during full-page stitching.
          const tab = sender.tab || (await getActiveTab());
          const dataUrl = await captureVisible(tab.windowId);
          sendResponse({ dataUrl });
          break;
        }
        case "RECORDING_DONE": {
          await markRecordingIdle();
          if (msg.dataUrl) {
            const stamp = new Date().toISOString().replace(/[:.]/g, "-");
            await chrome.downloads.download({
              url: msg.dataUrl,
              filename: `SnapShot-recording-${stamp}.webm`,
              saveAs: true,
            });
          }
          sendResponse({ ok: true });
          break;
        }
        default:
          sendResponse({ error: "Unknown message: " + msg.type });
      }
    } catch (err) {
      console.error("[SnapShot SW]", err);
      sendResponse({ error: friendlyError(err) });
    }
  })();

  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "paste-clip-history") {
      await showClipPicker();
    } else if (command === "toggle-recording") {
      const { recordingState } = await chrome.storage.local.get("recordingState");
      const prefs = (await chrome.storage.local.get("recPrefs")).recPrefs || {};
      await toggleRecording(recordingState?.active
        ? {}
        : { camera: !!prefs.camera, mic: !!prefs.mic, systemAudio: !!prefs.systemAudio });
    } else {
      await runCapture(command);
    }
  } catch (err) {
    console.error("[SnapShot SW] command", command, err);
  }
});

// Restore badge on startup if a recording somehow persisted.
chrome.runtime.onStartup.addListener(async () => {
  const { recordingState } = await chrome.storage.local.get("recordingState");
  if (recordingState?.active) {
    // Worker restarted mid-recording; offscreen is gone, so reset.
    await chrome.storage.local.set({ recordingState: { active: false, startedAt: 0 } });
  }
  await clearDiskCaptures().catch(() => {});
  syncPageQr();
  syncClipHistory();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ recordingState: { active: false, startedAt: 0 } });
  clearDiskCaptures().catch(() => {});
  syncPageQr();
  syncClipHistory();
});

clearDiskCaptures().catch(() => {});
syncClipHistory();

chrome.windows.onRemoved.addListener((id) => {
  if (recording.windowId && recording.windowId === id) {
    markRecordingIdle();
  }
});
