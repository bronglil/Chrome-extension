// ============================================================================
// SnapShot Studio — Recording studio
// Visible panel so the camera can stay on-screen (bottom) while we record
// the chosen screen/window/tab at native resolution. Camera, mic, and system
// audio are all optional — any combination works.
// ============================================================================

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const opts = {
  camera: params.get("cam") !== "0",
  mic: params.get("mic") === "1",
  systemAudio: params.get("audio") !== "0",
};

const state = {
  display: null,
  camera: null,
  mic: null,
  mixedAudio: null,
  audioCtx: null,
  recorder: null,
  chunks: [],
  composeTimer: 0,
  startedAt: 0,
  clock: 0,
  canvas: null,
};

function toast(msg, ms = 2400) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

function setStatus(text) {
  $("#status-label").textContent = text;
}

function flags() {
  const bits = [];
  bits.push(opts.camera && state.camera ? "Camera" : "No camera");
  bits.push(opts.mic && state.mic ? "Microphone" : "No mic");
  bits.push(opts.systemAudio && state.display?.getAudioTracks().length ? "System audio" : "No system audio");
  $("#flags").innerHTML = bits.map((b) => `<span class="flag">${b}</span>`).join("");
}

function pickDesktop(wantAudio) {
  return new Promise((resolve, reject) => {
    if (!chrome.desktopCapture?.chooseDesktopMedia) {
      return reject(new Error("Screen capture is not available in this window."));
    }
    const sources = ["screen", "window", "tab"];
    if (wantAudio) sources.push("audio");
    // Do not pass a tab — the stream must stay usable in THIS page.
    chrome.desktopCapture.chooseDesktopMedia(sources, (id) => {
      if (!id) reject(new Error("Capture cancelled."));
      else resolve(id);
    });
  });
}

async function getDisplayStream(wantAudio) {
  // Prefer getDisplayMedia from this click so Chrome keeps the share dialog.
  try {
    return await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
      audio: wantAudio,
      systemAudio: wantAudio ? "include" : "exclude",
      preferCurrentTab: false,
    });
  } catch (err) {
    const cancelled = /cancell|denied|abort|NotAllowed/i.test((err?.name || "") + (err?.message || ""));
    if (cancelled) throw new Error("Capture cancelled.");
    const streamId = await pickDesktop(wantAudio);
    return navigator.mediaDevices.getUserMedia({
      audio: wantAudio
        ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } }
        : false,
      video: {
        mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId },
      },
    });
  }
}

async function getCamera() {
  return navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 24, max: 24 },
    },
    audio: false,
  });
}

async function getMic() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
}

function mixAudio(streams) {
  const tracks = streams.flatMap((s) => (s ? s.getAudioTracks() : []));
  if (!tracks.length) return null;
  if (tracks.length === 1) return new MediaStream(tracks);
  const ctx = new AudioContext();
  state.audioCtx = ctx;
  const dest = ctx.createMediaStreamDestination();
  tracks.forEach((track) => {
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    src.connect(dest);
  });
  return dest.stream;
}

function attachPreview(el, stream) {
  el.srcObject = stream;
  el.muted = true;
  return el.play().catch(() => {});
}

function waitMeta(video) {
  if (video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    video.addEventListener("loadedmetadata", resolve, { once: true });
  });
}

function drawPip(ctx, cam, W, H) {
  const pipW = Math.round(Math.min(W * 0.22, 420));
  const pipH = Math.round(pipW * (cam.videoHeight && cam.videoWidth ? cam.videoHeight / cam.videoWidth : 0.75));
  const x = Math.round((W - pipW) / 2);
  const y = H - pipH - Math.round(H * 0.04);
  const r = Math.min(22, pipW / 8);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, pipW, pipH, r);
  ctx.clip();
  ctx.translate(x + pipW, y);
  ctx.scale(-1, 1);
  ctx.drawImage(cam, 0, 0, pipW, pipH);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = Math.max(3, Math.round(W / 480));
  ctx.beginPath();
  ctx.roundRect(x, y, pipW, pipH, r);
  ctx.stroke();
  ctx.restore();
}

function startComposer(screenEl, camEl) {
  const canvas = document.createElement("canvas");
  canvas.width = screenEl.videoWidth || 1920;
  canvas.height = screenEl.videoHeight || 1080;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  state.canvas = canvas;

  const fps = 24;
  const tick = () => {
    if (!state.recorder) return;
    ctx.drawImage(screenEl, 0, 0, canvas.width, canvas.height);
    if (camEl && camEl.readyState >= 2) drawPip(ctx, camEl, canvas.width, canvas.height);
  };
  tick();
  state.composeTimer = setInterval(tick, 1000 / fps);
  return canvas.captureStream(fps);
}

function pickMime() {
  return [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}

function bitrateFor(w, h) {
  const pixels = (w || 1920) * (h || 1080);
  // ~8 Mbps at 1080p, up to 20 Mbps at 4K — keep the screen sharp.
  return Math.round(Math.min(20_000_000, Math.max(8_000_000, pixels * 4)));
}

async function start() {
  setStatus("Choose a screen, window, or tab…");
  state.display = await getDisplayStream(opts.systemAudio);

  const screenEl = $("#screen-preview");
  await attachPreview(screenEl, state.display);
  await waitMeta(screenEl);
  $("#screen-empty").hidden = true;

  if (opts.camera) {
    try {
      state.camera = await getCamera();
      const camEl = $("#cam-preview");
      await attachPreview(camEl, state.camera);
      $("#person-panel").hidden = false;
      $("#person-off").hidden = true;
    } catch (err) {
      console.warn("[SnapShot] camera", err);
      opts.camera = false;
      $("#person-panel").hidden = true;
      $("#person-off").hidden = false;
      toast("Camera unavailable — recording the screen only.");
    }
  } else {
    $("#person-panel").hidden = true;
    $("#person-off").hidden = false;
  }

  if (opts.mic) {
    try {
      state.mic = await getMic();
    } catch (err) {
      console.warn("[SnapShot] mic", err);
      opts.mic = false;
      toast("Microphone unavailable — continuing without voice.");
    }
  }

  flags();

  const videoStream = opts.camera && state.camera
    ? startComposer(screenEl, $("#cam-preview"))
    : new MediaStream(state.display.getVideoTracks());

  state.mixedAudio = mixAudio([state.display, state.mic]);
  const tracks = [...videoStream.getVideoTracks()];
  if (state.mixedAudio) tracks.push(...state.mixedAudio.getAudioTracks());
  const out = new MediaStream(tracks);

  const vtrack = state.display.getVideoTracks()[0];
  const settings = vtrack?.getSettings?.() || {};
  const mimeType = pickMime();
  state.chunks = [];
  state.recorder = new MediaRecorder(out, {
    mimeType,
    videoBitsPerSecond: bitrateFor(settings.width || screenEl.videoWidth, settings.height || screenEl.videoHeight),
    audioBitsPerSecond: 192000,
  });
  state.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) state.chunks.push(e.data);
  };
  state.recorder.onstop = finalize;
  vtrack?.addEventListener("ended", () => {
    if (state.recorder && state.recorder.state !== "inactive") stop();
  });

  state.recorder.start(1000);
  state.startedAt = Date.now();
  $("#live-chip").hidden = false;
  $("#btn-share").hidden = true;
  $("#btn-stop").hidden = false;
  $("#btn-stop").disabled = false;
  setStatus(opts.camera && state.camera ? "Screen + camera" : "Screen only");
  tickClock();
  state.clock = setInterval(tickClock, 500);
  chrome.runtime.sendMessage({ type: "RECORDING_STARTED", startedAt: state.startedAt }).catch(() => {});
}

function tickClock() {
  const s = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  $("#rec-clock").textContent = `${mm}:${ss}`;
}

function stop() {
  $("#btn-stop").disabled = true;
  setStatus("Saving…");
  if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  else finalize();
}

async function finalize() {
  clearInterval(state.composeTimer);
  clearInterval(state.clock);
  const blob = new Blob(state.chunks, { type: "video/webm" });
  stopAll();
  chrome.runtime.sendMessage({ type: "RECORDING_DONE" }).catch(() => {});
  if (blob.size) {
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    try {
      await chrome.downloads.download({
        url,
        filename: `SnapShot-recording-${stamp}.webm`,
        saveAs: true,
      });
    } catch (err) {
      toast("Save failed: " + (err.message || err));
    }
  }
  setTimeout(() => window.close(), 400);
}

function stopAll() {
  [state.display, state.camera, state.mic].forEach((s) => {
    try { s?.getTracks().forEach((t) => t.stop()); } catch (_) { /* already ended */ }
  });
  try { state.audioCtx?.close(); } catch (_) { /* ignore */ }
  state.recorder = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "RECORDER_STOP") stop();
});

$("#btn-stop").addEventListener("click", stop);
$("#btn-share").addEventListener("click", () => {
  $("#btn-share").disabled = true;
  start().catch((err) => {
    $("#btn-share").disabled = false;
    $("#btn-share").hidden = false;
    $("#btn-stop").hidden = true;
    const cancelled = /cancell|denied|abort|NotAllowed/i.test((err?.name || "") + (err?.message || ""));
    if (cancelled) {
      setStatus("Share a screen to start");
      toast("Nothing was shared — click Share screen to try again.");
      return;
    }
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED", error: err.message }).catch(() => {});
    setStatus("Could not start");
    toast(err.message || String(err));
  });
});
window.addEventListener("beforeunload", () => {
  if (state.recorder && state.recorder.state === "recording") {
    try { state.recorder.stop(); } catch (_) { /* closing */ }
  } else if (!state.startedAt) {
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" }).catch(() => {});
  }
});
setStatus("Click Share screen to start");
