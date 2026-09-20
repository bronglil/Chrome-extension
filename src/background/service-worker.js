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
// Captured images are stashed in chrome.storage.local under a short id and the
// editor tab reads them back by id (avoids giant URLs / message payload limits).
// ============================================================================

const OFFSCREEN_PATH = "src/offscreen/offscreen.html";

// In-memory recording state (mirrored to storage so the popup survives worker
// restarts). The actual MediaRecorder lives in the offscreen document.
let recording = { active: false, startedAt: 0 };

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

async function stashAndOpenEditor(dataUrl, meta = {}) {
  const id = shortId();
  await chrome.storage.local.set({
    ["capture:" + id]: { dataUrl, meta, createdAt: Date.now() },
  });
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/editor/editor.html") + "?id=" + id,
  });
  return id;
}

async function openEmptyEditor() {
  await chrome.tabs.create({
    url: chrome.runtime.getURL("src/editor/editor.html"),
  });
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

function isRestricted(url = "") {
  return (
    url.startsWith("chrome://") ||
    url.startsWith("edge://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("https://chrome.google.com/webstore") ||
    url.startsWith("about:")
  );
}

// captureVisibleTab is rate-limited to ~2/sec; callers that loop must throttle.
async function captureVisible(windowId) {
  return chrome.tabs.captureVisibleTab(windowId, {
    format: "png",
  });
}

// Make sure the content script is present, then message it.
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "PING" });
  } catch (_) {
    await chrome.scripting.insertCSS({
      target: { tabId },
      files: ["src/content/area-select.css"],
    });
    await chrome.scripting.executeScript({
      target: { tabId },
      // Shared utils first so content.js can use SnapShotUtils.
      files: ["src/lib/utils.js", "src/content/content.js"],
    });
  }
}

// ---------------------------------------------------------------------------
// Capture actions
// ---------------------------------------------------------------------------
async function captureVisibleArea() {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab.");
  if (isRestricted(tab.url)) throw new Error("Can't capture this page.");
  const dataUrl = await captureVisible(tab.windowId);
  await stashAndOpenEditor(dataUrl, { kind: "visible", url: tab.url, title: tab.title });
}

async function captureArea() {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab.");
  if (isRestricted(tab.url)) throw new Error("Can't capture this page.");
  await ensureContentScript(tab.id);
  // The content script shows the overlay, returns the selected rectangle
  // (already scaled by devicePixelRatio) or null if cancelled.
  const rect = await chrome.tabs.sendMessage(tab.id, { type: "START_AREA_SELECT" });
  if (!rect) return; // cancelled
  const dataUrl = await captureVisible(tab.windowId);
  await stashAndOpenEditor(dataUrl, {
    kind: "area",
    cropRect: rect,
    url: tab.url,
    title: tab.title,
  });
}

async function captureFullPage() {
  const tab = await getActiveTab();
  if (!tab) throw new Error("No active tab.");
  if (isRestricted(tab.url)) throw new Error("Can't capture this page.");
  await ensureContentScript(tab.id);
  // The content script drives scroll-and-stitch, calling back to CAPTURE_SLICE
  // for each viewport (which we service with captureVisibleTab, throttled).
  const result = await chrome.tabs.sendMessage(tab.id, { type: "START_FULL_PAGE" });
  if (!result || result.error) throw new Error(result?.error || "Full-page capture failed.");
  await stashAndOpenEditor(result.dataUrl, {
    kind: "fullpage",
    width: result.width,
    height: result.height,
    tiles: result.tiles || 1,
    url: tab.url,
    title: tab.title,
  });
}

// Desktop capture (screen / window). Chrome always shows its picker.
function chooseDesktopMedia(sources, tab) {
  return new Promise((resolve, reject) => {
    const reqId = chrome.desktopCapture.chooseDesktopMedia(sources, tab, (streamId, opts) => {
      if (!streamId) return reject(new Error("Capture cancelled."));
      resolve({ streamId, opts });
    });
    // reqId can be used to cancel; not needed here.
    void reqId;
  });
}

async function captureDesktop(kind) {
  const tab = await getActiveTab();
  const sources = kind === "window" ? ["window"] : ["screen", "window"];
  const { streamId } = await chooseDesktopMedia(sources, tab);
  const res = await toOffscreen({ type: "GRAB_FRAME", streamId });
  if (res?.error) throw new Error(res.error);
  await stashAndOpenEditor(res.dataUrl, { kind: "desktop-" + kind });
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
async function toggleRecording(options = {}) {
  if (recording.active) {
    const res = await toOffscreen({ type: "STOP_RECORDING" });
    recording = { active: false, startedAt: 0 };
    await chrome.storage.local.set({ recordingState: recording });
    chrome.action.setBadgeText({ text: "" });
    if (res?.error) return { error: res.error, recording: false };
    return { recording: false };
  }

  const tab = await getActiveTab();
  // Screen/window + optional system audio via the desktop picker.
  const sources = ["screen", "window", "tab"];
  const { streamId } = await chooseDesktopMedia(
    options.systemAudio ? [...sources, "audio"] : sources,
    tab
  );
  const res = await toOffscreen({
    type: "START_RECORDING",
    streamId,
    mic: !!options.mic,
    systemAudio: !!options.systemAudio,
  });
  if (res?.error) return { error: res.error, recording: false };

  recording = { active: true, startedAt: Date.now() };
  await chrome.storage.local.set({ recordingState: recording });
  chrome.action.setBadgeBackgroundColor({ color: "#ef4444" });
  chrome.action.setBadgeText({ text: "●" });
  return { recording: true, startedAt: recording.startedAt };
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
    default: return Promise.reject(new Error("Unknown action: " + action));
  }
}

// ---------------------------------------------------------------------------
// Message router (popup, offscreen, editor, content)
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Ignore messages addressed to the offscreen document.
  if (msg?.target === "offscreen") return false;

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
          sendResponse(await toggleRecording(msg.options));
          break;
        case "GET_RECORDING_STATE":
          sendResponse({ recording: recording.active, startedAt: recording.startedAt });
          break;
        case "OPEN_EDITOR":
          await openEmptyEditor();
          sendResponse({ ok: true });
          break;
        case "CAPTURE_SLICE": {
          // Requested by the content script during full-page stitching.
          const tab = sender.tab || (await getActiveTab());
          const dataUrl = await captureVisible(tab.windowId);
          sendResponse({ dataUrl });
          break;
        }
        case "RECORDING_DONE": {
          // Offscreen finished a recording and produced a WebM blob URL/dataUrl.
          recording = { active: false, startedAt: 0 };
          await chrome.storage.local.set({ recordingState: recording });
          chrome.action.setBadgeText({ text: "" });
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
      sendResponse({ error: err.message || String(err) });
    }
  })();

  return true; // keep the channel open for the async response
});

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  try {
    if (command === "toggle-recording") {
      const { recordingState } = await chrome.storage.local.get("recordingState");
      await toggleRecording(recordingState?.active ? {} : { systemAudio: true });
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
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ recordingState: { active: false, startedAt: 0 } });
});
