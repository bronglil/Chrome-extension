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
  $("#rec-ico").textContent = active ? "⏹️" : "⏺️";
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
