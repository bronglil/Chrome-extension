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

async function refreshRecordingUI() {
  try {
    const state = await send({ type: "GET_RECORDING_STATE" });
    setRecordingUI(!!state?.recording);
  } catch (_) {
    /* worker may be asleep; ignore */
  }
}

function setRecordingUI(active) {
  const btn = $("#rec-toggle");
  $("#rec-label").textContent = active ? "Stop recording" : "Start recording";
  // The dot's shape (circle vs. square) is driven by the .recording CSS class.
  btn.classList.toggle("recording", active);
  $("#rec-status").hidden = !active;
}

// Capture / action buttons.
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const action = btn.dataset.action;
    const delay = parseInt(btn.dataset.delay || "0", 10);

    if (action === "toggle-recording") {
      const opts = {
        mic: $("#rec-mic").checked,
        systemAudio: $("#rec-audio").checked,
      };
      const res = await send({ type: "TOGGLE_RECORDING", options: opts });
      if (res?.error) return toast("⚠️ " + res.error);
      setRecordingUI(!!res?.recording);
      if (!res?.recording) window.close();
      return;
    }

    if (delay) {
      toast(`Capturing in ${delay}s…`);
      await send({ type: "CAPTURE", action, delayMs: delay * 1000 });
      window.close();
      return;
    }

    const res = await send({ type: "CAPTURE", action });
    if (res?.error) return toast("⚠️ " + res.error);
    // Most captures open a new editor tab; close popup so the picker/overlay is usable.
    window.close();
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
  const u = $("#qr-url");
  u.textContent = url;
  u.title = url;
}
// Exposed for E2E (the real popup gets the URL from chrome.tabs).
window.__snapRenderQR = renderPageQR;

async function initPageQR() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    renderPageQR(tab?.url || "");
  } catch (_) {
    renderPageQR("");
  }
}

$("#qr-copy-link").addEventListener("click", () => {
  if (!qrState.url) return;
  navigator.clipboard.writeText(qrState.url).then(() => toast("Link copied"));
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
});

initPageQR();

// Live recording timer while popup is open.
let timerInt = null;
async function tickTimer() {
  const state = await send({ type: "GET_RECORDING_STATE" }).catch(() => null);
  if (state?.recording && state.startedAt) {
    const s = Math.floor((Date.now() - state.startedAt) / 1000);
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    $("#rec-time").textContent = `${mm}:${ss}`;
  }
}

refreshRecordingUI();
timerInt = setInterval(tickTimer, 500);
window.addEventListener("unload", () => clearInterval(timerInt));
