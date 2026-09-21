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
  finalizing: false,
  recordClones: [],
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

function streamFromDesktopId(streamId, wantAudio) {
  return navigator.mediaDevices.getUserMedia({
    audio: wantAudio
      ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } }
      : false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: streamId,
        maxFrameRate: 30,
      },
    },
  });
}

function isRecorderSelfCapture(stream) {
  const label = (stream.getVideoTracks()[0]?.label || "").toLowerCase();
  if (!label) return false;
  return /snapshot studio|recorder\.html|snapshot-studio/.test(label)
    || (label.includes("recording") && label.includes("snapshot"));
}

async function getDisplayStream(wantAudio) {
  // Use Chrome's desktop picker from this page so the stream is the screen /
  // window / tab the user chose — not this Recording window.
  // getDisplayMedia on chrome-extension:// pages often captures this tab.
  let thisWin = null;
  try { thisWin = await chrome.windows.getCurrent(); } catch (_) { /* ignore */ }
  if (thisWin?.id) {
    try { await chrome.windows.update(thisWin.id, { state: "minimized" }); } catch (_) { /* ignore */ }
  }
  try {
    const streamId = await pickDesktop(wantAudio);
    const stream = await streamFromDesktopId(streamId, wantAudio);
    if (isRecorderSelfCapture(stream)) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Pick the screen, window, or page you want in the video — not this Recording window.");
    }
    return stream;
  } finally {
    if (thisWin?.id) {
      try {
        await chrome.windows.update(thisWin.id, { state: "normal", focused: true });
      } catch (_) { /* ignore */ }
    }
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

async function attachPreview(el, stream) {
  el.srcObject = stream;
  el.muted = true;
  el.autoplay = true;
  el.playsInline = true;
  try {
    await el.play();
  } catch (_) {
    await new Promise((r) => setTimeout(r, 40));
    await el.play().catch(() => {});
  }
}

function waitMeta(video) {
  if (video.readyState >= 2 && video.videoWidth) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("playing", done);
      resolve();
    };
    video.addEventListener("loadeddata", done);
    video.addEventListener("playing", done);
    setTimeout(done, 1200);
  });
}

function videoForRecord(display) {
  const track = display.getVideoTracks()[0];
  if (!track) return new MediaStream();
  track.enabled = true;
  const clone = track.clone();
  state.recordClones.push(clone);
  return new MediaStream([clone]);
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

function pickMime(hasAudio) {
  const list = hasAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}

function bitrateFor(w, h) {
  const pixels = (w || 1920) * (h || 1080);
  // ~8 Mbps at 1080p, up to 20 Mbps at 4K — keep the screen sharp.
  return Math.round(Math.min(20_000_000, Math.max(8_000_000, pixels * 4)));
}

async function start() {
  setStatus("Choose a screen, window, or tab…");
  state.recordClones = [];
  state.finalizing = false;
  state.display = await getDisplayStream(opts.systemAudio);

  const screenEl = $("#screen-preview");
  await attachPreview(screenEl, state.display);
  await waitMeta(screenEl);
  $("#screen-empty").hidden = true;
  screenEl.classList.add("is-live");

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
    : videoForRecord(state.display);

  state.mixedAudio = mixAudio([state.display, state.mic]);
  const tracks = [...videoStream.getVideoTracks()];
  if (state.mixedAudio) tracks.push(...state.mixedAudio.getAudioTracks());
  const out = new MediaStream(tracks);

  const vtrack = state.display.getVideoTracks()[0];
  const settings = vtrack?.getSettings?.() || {};
  const hasAudio = !!(state.mixedAudio && state.mixedAudio.getAudioTracks().length);
  const mimeType = pickMime(hasAudio);
  state.chunks = [];
  const recOpts = {
    mimeType,
    videoBitsPerSecond: bitrateFor(settings.width || screenEl.videoWidth, settings.height || screenEl.videoHeight),
  };
  if (hasAudio) recOpts.audioBitsPerSecond = 192000;
  try {
    state.recorder = new MediaRecorder(out, recOpts);
  } catch (_) {
    state.recorder = new MediaRecorder(out, { mimeType: "video/webm" });
  }
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

function waitForDownload(id) {
  return new Promise((resolve) => {
    if (id == null) return resolve();
    const finish = (delta) => {
      if (delta.id !== id) return;
      const s = delta.state?.current;
      if (s === "complete" || s === "interrupted") {
        chrome.downloads.onChanged.removeListener(finish);
        resolve(s);
      }
    };
    chrome.downloads.onChanged.addListener(finish);
    setTimeout(() => {
      chrome.downloads.onChanged.removeListener(finish);
      resolve("timeout");
    }, 120000);
  });
}

async function finalize() {
  if (state.finalizing) return;
  state.finalizing = true;
  clearInterval(state.composeTimer);
  clearInterval(state.clock);
  const blob = new Blob(state.chunks, { type: "video/webm" });
  stopAll();
  chrome.runtime.sendMessage({ type: "RECORDING_DONE" }).catch(() => {});
  if (!blob.size) {
    setStatus("Nothing was recorded");
    toast("Recording was empty — try Share screen again.");
    $("#btn-stop").hidden = true;
    $("#btn-share").hidden = false;
    $("#btn-share").disabled = false;
    state.finalizing = false;
    state.startedAt = 0;
    return;
  }
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: `SnapShot-recording-${stamp}.webm`,
      saveAs: params.get("saveAs") !== "0",
    });
    await waitForDownload(downloadId);
    setStatus("Saved");
    setTimeout(() => window.close(), 600);
  } catch (err) {
    setStatus("Save failed");
    toast("Save failed: " + (err.message || err));
    $("#btn-stop").hidden = true;
    $("#btn-share").hidden = false;
    $("#btn-share").disabled = false;
    state.finalizing = false;
    state.startedAt = 0;
  }
}

function stopAll() {
  [state.display, state.camera, state.mic].forEach((s) => {
    try { s?.getTracks().forEach((t) => t.stop()); } catch (_) { /* already ended */ }
  });
  state.recordClones.forEach((t) => { try { t.stop(); } catch (_) { /* already ended */ } });
  state.recordClones = [];
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
    const cancelled = /cancell|denied|abort|NotAllowed|not this Recording/i.test((err?.name || "") + (err?.message || ""));
    if (cancelled) {
      setStatus("Share a screen to start");
      toast(err.message && /not this Recording/i.test(err.message)
        ? err.message
        : "Nothing was shared — click Share screen to try again.");
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
