// Popup UI controller. Sends messages to the service worker, which orchestrates
// everything (capture, offscreen document, recording). The popup itself does no
// media work — it closes as soon as a capture starts.

const $ = (sel) => document.querySelector(sel);

function toast(msg, ms = 1800) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// Ask the service worker to do something, return its response.
function send(message) {
  return chrome.runtime.sendMessage(message);
}

// Persist the job before the popup closes. sendMessage from a dying popup
// is often dropped in MV3; session storage always wakes the worker.
async function queueJob(job) {
  const payload = { ...job, at: Date.now() };
  try {
    await chrome.storage.session.set({ pendingJob: payload });
  } catch (_) { /* session unavailable — kick the worker directly */ }
  // Wake the worker immediately. Do not wait for the capture itself: area
  // select needs the popup closed so the page is visible to drag on.
  chrome.runtime.sendMessage({ type: "RUN_PENDING", job: payload }).catch(() => {});
}

// Host access is in the manifest, but Chrome may still prompt (or leave it
// off after an unpacked/CDP load). Must run in this click handler.
async function ensureSiteAccess() {
  try {
    const have = await chrome.permissions.contains({ origins: ["<all_urls>"] });
    if (have) return true;
    return await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch (_) {
    return false;
  }
}

async function refreshRecordingUI() {
  try {
    const state = await send({ type: "GET_RECORDING_STATE" });
    applyRecordingState(state);
  } catch (_) {
    /* worker may be asleep; try storage mirror */
    try {
      const stored = (await chrome.storage.local.get("recordingState")).recordingState;
      applyRecordingState(stored);
    } catch (_) { /* ignore */ }
  }
}

function applyRecordingState(state) {
  if (!state) {
    setRecordingUI(false, false);
    return;
  }
  const on = !!(state.recording || state.active);
  const active = on && !!state.startedAt && !state.pending;
  const pending = on && !active;
  setRecordingUI(active, pending);
  if (active && state.startedAt) {
    const s = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    const el = $("#rec-time");
    if (el) el.textContent = `${mm}:${ss}`;
  }
}

function setRecordingUI(active, pending = false) {
  const btn = $("#rec-toggle");
  const label = $("#rec-label");
  if (!btn || !label) return;
  label.textContent = active
    ? "Stop recording"
    : pending
      ? "Starting…"
      : "Start recording";
  btn.classList.toggle("recording", active);
  btn.classList.toggle("pending", pending && !active);
  const status = $("#rec-status");
  if (status) status.hidden = !active;
}

// Capture / action buttons.
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    const delay = parseInt(btn.dataset.delay || "0", 10);
    if (!(await ensureSiteAccess())) {
      return toast("⚠️ Allow site access to capture pages.");
    }

    if (action === "toggle-recording") {
      const opts = {
        camera: $("#rec-cam").checked,
        mic: $("#rec-mic").checked,
        systemAudio: $("#rec-audio").checked,
        quality: $("#rec-quality")?.value || "720",
        pip: "bc",
        blur: !!$("#rec-blur")?.checked,
        cues: $("#rec-cues") ? !!$("#rec-cues").checked : true,
        mp4: !!$("#rec-mp4")?.checked,
      };
      persistRecPrefs(opts);
      const cur = await send({ type: "GET_RECORDING_STATE" }).catch(() => null);
      const live = !!(cur?.recording && cur?.startedAt && !cur?.pending);
      if (live) {
        setRecordingUI(false, false);
        toast("Stopping…");
      } else {
        setRecordingUI(false, true);
        toast("Starting…");
      }
      await queueJob({ type: "RECORD", options: opts });
      // Give the worker a moment to open/stop the recorder, then close.
      setTimeout(() => window.close(), 180);
      return;
    }

    try {
      if (delay) toast(`Capturing in ${delay}s…`);
      await queueJob({ type: "CAPTURE", action, delayMs: delay ? delay * 1000 : 0 });
      window.close();
    } catch (err) {
      toast("⚠️ " + (err.message || String(err)));
    }
  });
});

$("#open-editor").addEventListener("click", async () => {
  await send({ type: "OPEN_EDITOR", empty: true });
  window.close();
});

$("#open-pdf").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("src/pdf/pdf-editor.html") });
  window.close();
});

// ---------------------------------------------------------------------------
// Page QR — encode the active tab's URL, with copy / save / share.
// ---------------------------------------------------------------------------
/* global qrcode */
let qrState = { url: "", dataUrl: "" };

function renderPageQR(url) {
  const section = $("#qr-section");
  const note = $("#qr-note");
  const shareable = /^https?:\/\//i.test(url || "");
  if (!shareable) {
    section.hidden = true;
    note.hidden = false;
    note.textContent = url ? "This page can't be shared as a link." : "No active page.";
    return;
  }
  section.hidden = false;
  note.hidden = true;

  // Encode (auto version, medium error-correction so it survives some scaling).
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const dataUrl = qr.createDataURL(4, 8); // cellSize, margin

  qrState = { url, dataUrl };
  $("#qr-img").src = dataUrl;
}
// Exposed for E2E (the real popup gets the URL from chrome.tabs).
window.__snapRenderQR = renderPageQR;

async function currentPageTab() {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && /^https?:/i.test(active.url || "")) return active;
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return tabs.find((t) => /^https?:/i.test(t.url || "")) || active || null;
  } catch (_) {
    return null;
  }
}

function renderPageCard(tab) {
  const url = tab?.url || "";
  const shareable = /^https?:/i.test(url);
  $("#hdr-page").textContent = shareable
    ? (tab.title || hostOf(url) || "This page")
    : "Ready to capture";
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}

async function initPageQR() {
  const tab = await currentPageTab();
  renderPageCard(tab);
  renderPageQR(tab?.url || "");
}

$("#qr-copy-link").addEventListener("click", () => {
  if (!qrState.url) return;
  navigator.clipboard.writeText(qrState.url).then(() => toast("Link copied"));
  send({ type: "CLIP_REMEMBER", text: qrState.url }).catch(() => {});
});

$("#qr-copy-img").addEventListener("click", async () => {
  if (!qrState.dataUrl) return;
  try {
    const blob = await (await fetch(qrState.dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("QR image copied");
  } catch (e) {
    toast("Copy failed");
  }
});

$("#qr-save").addEventListener("click", () => {
  if (!qrState.dataUrl) return;
  let host = "page";
  try { host = new URL(qrState.url).hostname || "page"; } catch (_) {}
  chrome.downloads.download({ url: qrState.dataUrl, filename: `qr-${host}.png` });
  toast("Saving QR…");
});

$("#qr-share").addEventListener("click", async () => {
  if (!qrState.url) return;
  if (navigator.share) {
    try { await navigator.share({ title: "Page link", url: qrState.url }); return; }
    catch (_) { /* cancelled or unsupported — fall through */ }
  }
  navigator.clipboard.writeText(qrState.url).then(() => toast("Link copied (share unavailable)"));
  send({ type: "CLIP_REMEMBER", text: qrState.url }).catch(() => {});
});

initPageQR();

// On-page QR overlay toggle (opt-in, persisted in the service worker).
(async () => {
  const box = $("#page-qr-toggle");
  if (!box) return;
  try {
    const state = await send({ type: "GET_PAGE_QR" });
    box.checked = !!state?.on;
  } catch (_) {}
  box.addEventListener("change", async () => {
    if (box.checked && !(await ensureSiteAccess())) {
      box.checked = false;
      return toast("⚠️ Allow site access to show the page QR.");
    }
    send({ type: "SET_PAGE_QR", on: box.checked }).catch(() => {});
    toast(box.checked ? "QR shown on pages" : "QR hidden on pages");
  });
})();

// Live recording timer while popup is open.
let timerInt = null;
async function tickTimer() {
  await refreshRecordingUI();
}

const REC_PREFS = "recPrefs";
function persistRecPrefs(opts) {
  chrome.storage.local.set({ [REC_PREFS]: opts }).catch(() => {});
}
(async () => {
  try {
    const stored = (await chrome.storage.local.get(REC_PREFS))[REC_PREFS];
    if (!stored) return;
    if (typeof stored.camera === "boolean") $("#rec-cam").checked = stored.camera;
    if (typeof stored.mic === "boolean") $("#rec-mic").checked = stored.mic;
    if (typeof stored.systemAudio === "boolean") $("#rec-audio").checked = stored.systemAudio;
    if (typeof stored.blur === "boolean" && $("#rec-blur")) $("#rec-blur").checked = stored.blur;
    if (typeof stored.cues === "boolean" && $("#rec-cues")) $("#rec-cues").checked = stored.cues;
    if (typeof stored.mp4 === "boolean" && $("#rec-mp4")) $("#rec-mp4").checked = stored.mp4;
    if (stored.quality && $("#rec-quality")) $("#rec-quality").value = stored.quality;
  } catch (_) { /* first run */ }
})();

function currentRecPrefs() {
  return {
    camera: $("#rec-cam").checked,
    mic: $("#rec-mic").checked,
    systemAudio: $("#rec-audio").checked,
    quality: $("#rec-quality")?.value || "720",
    pip: "bc",
    blur: !!$("#rec-blur")?.checked,
    cues: $("#rec-cues") ? !!$("#rec-cues").checked : true,
    mp4: !!$("#rec-mp4")?.checked,
  };
}

$("#rec-quality")?.addEventListener("change", () => {
  persistRecPrefs(currentRecPrefs());
});
$("#rec-blur")?.addEventListener("change", () => {
  persistRecPrefs(currentRecPrefs());
});
$("#rec-cues")?.addEventListener("change", () => {
  persistRecPrefs(currentRecPrefs());
});
$("#rec-mp4")?.addEventListener("change", () => {
  persistRecPrefs(currentRecPrefs());
});
$("#rec-cam")?.addEventListener("change", () => persistRecPrefs(currentRecPrefs()));
$("#rec-mic")?.addEventListener("change", () => persistRecPrefs(currentRecPrefs()));
$("#rec-audio")?.addEventListener("change", () => persistRecPrefs(currentRecPrefs()));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.recordingState) return;
  applyRecordingState(changes.recordingState.newValue);
});

window.__applyRec = applyRecordingState;

refreshRecordingUI();
timerInt = setInterval(tickTimer, 500);
window.addEventListener("unload", () => clearInterval(timerInt));
