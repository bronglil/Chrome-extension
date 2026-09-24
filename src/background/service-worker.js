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
// restarts). The MediaRecorder lives in the recorder window.
let recording = { active: false, startedAt: 0, pending: false, windowId: 0, tabId: 0 };

function recordingSnapshot() {
  return {
    recording: !!recording.active,
    startedAt: recording.startedAt || 0,
    pending: !!recording.pending,
  };
}

async function windowExists(id) {
  if (!id) return false;
  try {
    await chrome.windows.get(id);
    return true;
  } catch (_) {
    return false;
  }
}

async function tabExists(id) {
  if (!id) return false;
  try {
    await chrome.tabs.get(id);
    return true;
  } catch (_) {
    return false;
  }
}

// Rebuild memory from storage + the live recorder window (SW often restarts).
// Note: without the "tabs" permission, tab.url is often hidden — identify the
// recorder by the window/tab ids we stored when opening it.
async function hydrateRecording() {
  let stored = null;
  try {
    stored = (await chrome.storage.local.get("recordingState")).recordingState || null;
  } catch (_) { /* ignore */ }

  const windowId = recording.windowId || stored?.windowId || 0;
  const tabId = recording.tabId || stored?.tabId || 0;
  const alive = (await tabExists(tabId)) || (await windowExists(windowId)) || !!(await findRecorderTab());

  if (!alive) {
    if (recording.active || stored?.active) {
      recording = { active: false, startedAt: 0, pending: false, windowId: 0, tabId: 0 };
      await localSet({ recordingState: recording }).catch(() => {});
      try { chrome.action.setBadgeText({ text: "" }); } catch (_) { /* ignore */ }
    }
    return recordingSnapshot();
  }

  const startedAt = recording.startedAt || stored?.startedAt || 0;
  const pending = !startedAt || !!(stored?.pending && !startedAt);
  recording = {
    active: true,
    startedAt,
    pending: !startedAt,
    windowId: windowId || recording.windowId || 0,
    tabId: tabId || recording.tabId || 0,
  };
  await localSet({ recordingState: recording }).catch(() => {});
  if (startedAt) {
    try {
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
      chrome.action.setBadgeText({ text: "●" });
    } catch (_) { /* ignore */ }
  }
  return recordingSnapshot();
}

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

// chrome.storage.local is ~10 MB. Old PNG data URLs under capture:/ocr: (or
// anything else) fill it, then even a tiny recordingState write throws
// Resource::kQuotaBytes. Keep only small prefs; never store screenshots here.
const KEEP_LOCAL = new Set(["recordingState", "recPrefs", "pageQrEnabled"]);

async function purgeStorage() {
  try {
    const all = await chrome.storage.local.get(null);
    const drop = Object.keys(all).filter((k) => !KEEP_LOCAL.has(k));
    for (let i = 0; i < drop.length; i += 16) {
      await chrome.storage.local.remove(drop.slice(i, i + 16));
    }
  } catch (e) {
    console.warn("[SnapShot] purge", e);
  }
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase("snapshot-captures");
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  } catch (_) { /* nothing to wipe */ }
}

async function localSet(obj) {
  try {
    await chrome.storage.local.set(obj);
  } catch (e) {
    if (!/quota/i.test(String(e?.message || e))) throw e;
    await purgeStorage();
    await chrome.storage.local.set(obj);
  }
}

const storageReady = purgeStorage();

// Content scripts cannot read chrome.storage.session unless we opt them in.
const sessionPagesReady = chrome.storage.session
  .setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
  .catch((e) => console.warn("[SnapShot] session access", e));

async function stashAndOpenEditor(dataUrl, meta = {}) {
  await storageReady;
  const id = shortId();
  const payload = { dataUrl, meta, createdAt: Date.now() };
  pendingCaptures.set(id, payload);
  setTimeout(() => pendingCaptures.delete(id), 120000);
  // Offscreen stays alive when the worker is killed (opening a tab often
  // suspends it). Without this the editor boots to a blank canvas.
  try {
    await ensureOffscreen();
    await toOffscreen({ type: "HOLD_CAPTURE", id, dataUrl, meta, createdAt: payload.createdAt });
  } catch (e) {
    console.warn("[SnapShot] hold capture", e);
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/editor/editor.html") + "?id=" + id,
  });
  return id;
}

async function takeCapture(id) {
  const mem = pendingCaptures.get(id);
  if (mem) {
    pendingCaptures.delete(id);
    toOffscreen({ type: "DROP_CAPTURE", id }).catch(() => {});
    return mem;
  }
  try {
    const held = await toOffscreen({ type: "TAKE_CAPTURE", id });
    if (held?.dataUrl) return held;
  } catch (_) { /* offscreen not ready */ }
  return null;
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
    if (job.at && queuedJob?.at === job.at) return;
    queuedJob = job;
    return;
  }
  jobBusy = true;
  lastJobAt = job.at || Date.now();
  try {
    await storageReady;
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
  await localSet({ pageQrEnabled: on });
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
  allFrames: true,
  persistAcrossSessions: true,
};

async function clipList() {
  await sessionPagesReady;
  const { clipHistory } = await chrome.storage.session.get(CLIP_KEY);
  return Array.isArray(clipHistory) ? clipHistory : [];
}

async function rememberClip(text) {
  const t = String(text || "").trim();
  if (!t) return;
  const clipped = t.length > 8000 ? t.slice(0, 8000) : t;
  const list = await clipList();
  await chrome.storage.session.set({
    [CLIP_KEY]: [clipped, ...list.filter((x) => x !== clipped)].slice(0, CLIP_MAX),
  });
}

async function syncClipHistory() {
  try {
    await sessionPagesReady;
    await chrome.scripting.unregisterContentScripts({ ids: ["cliphist"] }).catch(() => {});
    await chrome.scripting.registerContentScripts([CLIP_SCRIPT]);
  } catch (e) { console.warn("[SnapShot] cliphist", e); }
  // Dynamic registration only applies to future navigations — seed open tabs now.
  try {
    const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
    await Promise.all(tabs.map((tab) => chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: CLIP_SCRIPT.js,
    }).catch(() => {})));
  } catch (e) { console.warn("[SnapShot] cliphist inject", e); }
}

async function showClipPicker() {
  const tab = await getActiveTab();
  if (!isCapturable(tab)) return;
  const items = await clipList();
  const payload = { type: "SHOW_CLIP_PICKER", items };
  const send = () => chrome.tabs.sendMessage(tab.id, payload);
  try {
    await send();
  } catch (_) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      files: CLIP_SCRIPT.js,
    }).catch(() => {});
    await send().catch(() => {});
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
  if (api >= 5) return;
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

async function captureElement() {
  const tab = await getCaptureTab();
  await ensureContentScript(tab.id);
  const result = await chrome.tabs.sendMessage(tab.id, { type: "START_ELEMENT_CAPTURE" });
  if (!result || result.cancelled) return;
  if (result.error) throw new Error(result.error || "Element capture failed.");
  await stashAndOpenEditor(result.dataUrl, pageMeta(tab, {
    kind: "element",
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

  const fill = async (text, error) => {
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: "FILL_COPY_TEXT",
        text,
        error: text ? "" : (error || "No text found in this area."),
      });
    } catch (_) { /* overlay already closed */ }
  };

  // Selectable page text is instant — skip OCR when the DOM already has it.
  const domText = String(result.domText || "").trim();
  if (domText.replace(/\s+/g, " ").length >= 8) {
    await fill(domText);
    return;
  }

  const dataUrl = await captureVisible(tab.windowId);
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "COPY_TEXT_CAPTURED" });
  } catch (_) { /* overlay gone */ }

  const res = await toOffscreen({ type: "OCR_CROP", dataUrl, rect });
  const text = String(res?.text || "").trim() || domText;
  await fill(text, res?.error);
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
  const isRecorder = (t) => {
    const url = t.url || "";
    return url.startsWith(prefix) || url.includes("/src/recorder/recorder.html");
  };

  if (recording.tabId) {
    try {
      const tab = await chrome.tabs.get(recording.tabId);
      if (tab) return tab;
    } catch (_) { /* gone */ }
  }
  if (recording.windowId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: recording.windowId });
      if (tabs[0]) return tabs[0];
    } catch (_) { /* window already gone */ }
  }
  try {
    const stored = (await chrome.storage.local.get("recordingState")).recordingState;
    if (stored?.tabId) {
      try { return await chrome.tabs.get(stored.tabId); } catch (_) { /* gone */ }
    }
    if (stored?.windowId) {
      const tabs = await chrome.tabs.query({ windowId: stored.windowId });
      if (tabs[0]) return tabs[0];
    }
  } catch (_) { /* ignore */ }

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
  await localSet({ recordingState: recording });
  await chrome.windows.update(tab.windowId, { focused: true });
  return { recording: true, pending: !!recording.pending, startedAt: recording.startedAt };
}

async function toggleRecording(options = {}) {
  await hydrateRecording();
  const existing = await findRecorderTab();
  const live = !!(recording.active && recording.startedAt && !recording.pending);

  if (live) {
    chrome.runtime.sendMessage({ type: "RECORDER_STOP" }).catch(() => {});
    return { recording: true, stopping: true, startedAt: recording.startedAt };
  }

  // A leftover share window (never started) blocks a new recording. Close it
  // and open a fresh one so Start always works.
  if (existing) {
    try { await chrome.windows.remove(existing.windowId); } catch (_) { /* gone */ }
  }

  const quality = ["720", "1080", "1440"].includes(String(options.quality))
    ? String(options.quality)
    : "720";
  const pip = ["bl", "bc", "br"].includes(String(options.pip))
    ? String(options.pip)
    : "bc";
  const qs = new URLSearchParams({
    cam: options.camera ? "1" : "0",
    mic: options.mic ? "1" : "0",
    audio: options.systemAudio ? "1" : "0",
    q: quality,
    pip,
    blur: options.blur ? "1" : "0",
    cues: options.cues === false || options.cues === 0 || options.cues === "0" ? "0" : "1",
    autostart: "1",
  });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("src/recorder/recorder.html") + "?" + qs.toString(),
    type: "popup",
    width: 420,
    height: 620,
    focused: true,
  });
  const tabId = win.tabs?.[0]?.id || 0;
  recording = { active: true, startedAt: 0, pending: true, windowId: win.id, tabId };
  await localSet({ recordingState: recording });
  return { recording: true, pending: true, startedAt: 0 };
}

async function markRecordingStarted(startedAt) {
  const tab = await findRecorderTab();
  recording = {
    active: true,
    startedAt: startedAt || Date.now(),
    pending: false,
    windowId: tab?.windowId || recording.windowId || 0,
    tabId: tab?.id || recording.tabId || 0,
  };
  await localSet({ recordingState: recording });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  chrome.action.setBadgeText({ text: "●" });
}

async function markRecordingIdle() {
  recording = { active: false, startedAt: 0, pending: false, windowId: 0, tabId: 0 };
  await localSet({ recordingState: recording });
  chrome.action.setBadgeText({ text: "" });
}

async function closeRecorderWindow() {
  const windowId = recording.windowId;
  const tab = await findRecorderTab();
  const id = tab?.windowId || windowId;
  recording.windowId = 0;
  recording.tabId = 0;
  if (!id) return;
  try { await chrome.windows.remove(id); } catch (_) { /* already gone */ }
}

// ---------------------------------------------------------------------------
// Delayed capture
// ---------------------------------------------------------------------------
function runCapture(action) {
  switch (action) {
    case "capture-visible": return captureVisibleArea();
    case "capture-area": return captureArea();
    case "capture-full-page": return captureFullPage();
    case "capture-element": return captureElement();
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
          sendResponse(await hydrateRecording());
          break;
        case "RECORDING_STARTED":
          await markRecordingStarted(msg.startedAt);
          sendResponse({ ok: true });
          break;
        case "RECORDING_COUNTDOWN":
          recording = {
            ...recording,
            active: true,
            pending: true,
            startedAt: 0,
          };
          await localSet({ recordingState: recording });
          sendResponse({ ok: true });
          break;
        case "CLIP_REMEMBER":
          await rememberClip(msg.text);
          sendResponse({ ok: true });
          break;
        case "GET_CLIP_HISTORY":
          sendResponse({ items: await clipList() });
          break;
        case "RUN_PENDING":
          consumePendingJob(msg.job || (await chrome.storage.session.get("pendingJob")).pendingJob);
          sendResponse({ ok: true });
          break;
        case "TAKE_CAPTURE":
          sendResponse((await takeCapture(msg.id)) || {});
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
        case "CLOSE_RECORDER":
          await markRecordingIdle();
          await closeRecorderWindow();
          sendResponse({ ok: true });
          break;
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
        : {
          camera: !!prefs.camera,
          mic: !!prefs.mic,
          systemAudio: !!prefs.systemAudio,
          quality: prefs.quality || "720",
          pip: prefs.pip || "bc",
          blur: !!prefs.blur,
          cues: prefs.cues !== false,
        });
    } else {
      await runCapture(command);
    }
  } catch (err) {
    console.error("[SnapShot SW] command", command, err);
  }
});

// Restore badge on startup if a recording somehow persisted.
chrome.runtime.onStartup.addListener(async () => {
  await storageReady;
  await hydrateRecording();
  const { recordingState } = await chrome.storage.local.get("recordingState");
  // Browser restart: drop stale "recording" if the recorder window is gone.
  if (recordingState?.active && !(await findRecorderTab())) {
    await markRecordingIdle();
  }
  syncPageQr();
  syncClipHistory();
});

chrome.runtime.onInstalled.addListener(async () => {
  await storageReady;
  await localSet({ recordingState: { active: false, startedAt: 0, pending: false, windowId: 0, tabId: 0 } });
  recording = { active: false, startedAt: 0, pending: false, windowId: 0, tabId: 0 };
  syncPageQr();
  syncClipHistory();
});

storageReady.then(() => {
  hydrateRecording().catch(() => {});
  syncClipHistory();
}).catch(() => syncClipHistory());

chrome.windows.onRemoved.addListener((id) => {
  if (recording.windowId && recording.windowId === id) {
    markRecordingIdle();
  }
});
