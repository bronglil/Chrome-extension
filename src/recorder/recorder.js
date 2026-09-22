// ============================================================================
// SnapShot Studio — Recording studio
//
// Recording starts without a screen share. The MediaRecorder always encodes a
// compositor canvas so you can add, change, or remove the shared screen later
// without stopping. Camera and mic are optional and attach the same way.
// ============================================================================

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

const opts = {
  camera: params.get("cam") !== "0",
  mic: params.get("mic") === "1",
  systemAudio: params.get("audio") !== "0",
};

const OUT_W = 1280;
const OUT_H = 720;

const state = {
  display: null,
  camera: null,
  mic: null,
  mixedAudio: null,
  audioCtx: null,
  mixDest: null,
  recorder: null,
  chunks: [],
  composeTimer: 0,
  composing: false,
  startedAt: 0,
  clock: 0,
  canvas: null,
  ctx: null,
  finalizing: false,
  sharing: false,
  starting: false,
  pickerReqId: null,
  picking: false,
  saved: false,
  countdownTimer: 0,
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
  const bits = [
    { label: state.sharing ? "Screen on" : "No screen", on: state.sharing, live: state.sharing },
    { label: opts.camera && state.camera ? "Camera on" : "Camera off", on: !!(opts.camera && state.camera) },
    { label: opts.mic && state.mic ? "Mic on" : "Mic off", on: !!(opts.mic && state.mic) },
    {
      label: opts.systemAudio && state.display?.getAudioTracks().length ? "System audio" : "No system audio",
      on: !!(opts.systemAudio && state.display?.getAudioTracks().length),
    },
  ];
  $("#flags").innerHTML = bits.map((b) => {
    const cls = ["flag", b.on ? "is-on" : "", b.live ? "is-live" : ""].filter(Boolean).join(" ");
    return `<span class="${cls}">${b.label}</span>`;
  }).join("");
}

function syncShareButtons() {
  const label = state.sharing ? "Change screen" : "Share screen";
  const liveLabel = state.sharing ? "Change" : "Share";
  const share = $("#btn-share");
  const shareLive = $("#btn-share-live");
  const shareLabel = $("#share-label");
  const shareLabelLive = $("#share-label-live");
  if (shareLabel) shareLabel.textContent = label;
  else if (share) share.textContent = label;
  if (shareLabelLive) shareLabelLive.textContent = liveLabel;
  $("#btn-unshare").hidden = !state.sharing || !!state.startedAt;
  $("#screen-empty").hidden = state.sharing;
  $("#screen-preview").classList.toggle("is-live", state.sharing);
}

function setLiveUi(live) {
  document.body.classList.toggle("is-live", live);
  $("#live-chip").hidden = !live;
  $("#actions-ready").hidden = live;
  $("#actions-live").hidden = !live;
  $("#btn-stop").disabled = !live;
  if (live) {
    $("#btn-start").hidden = true;
    $("#person-off").hidden = true;
  }
}

function liveStatus() {
  if (state.starting && !state.startedAt) return setStatus("Countdown…");
  if (!state.startedAt) return setStatus("Ready to record");
  if (state.sharing && opts.camera && state.camera) return setStatus("Screen + camera · live");
  if (state.sharing) return setStatus("Screen shared · live");
  if (opts.camera && state.camera) return setStatus("Camera only · share anytime");
  setStatus("Recording · share a screen anytime");
}

function cancelSharePicker() {
  const id = state.pickerReqId;
  state.pickerReqId = null;
  state.picking = false;
  if (id != null && chrome.desktopCapture?.cancelChooseDesktopMedia) {
    try { chrome.desktopCapture.cancelChooseDesktopMedia(id); } catch (_) { /* ignore */ }
  }
}

function pickDesktop(wantAudio) {
  return new Promise((resolve, reject) => {
    if (!chrome.desktopCapture?.chooseDesktopMedia) {
      return reject(new Error("Screen capture is not available in this window."));
    }
    const sources = ["screen", "window", "tab"];
    if (wantAudio) sources.push("audio");
    state.picking = true;
    const reqId = chrome.desktopCapture.chooseDesktopMedia(sources, (id) => {
      if (state.pickerReqId === reqId) state.pickerReqId = null;
      state.picking = false;
      if (state.finalizing || !state.startedAt) {
        reject(new Error("Capture cancelled."));
        return;
      }
      if (!id) reject(new Error("Capture cancelled."));
      else resolve(id);
    });
    state.pickerReqId = reqId;
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
  const track = stream.getVideoTracks()[0];
  if (!track) return false;
  const label = (track.label || "").toLowerCase();
  const surface = String(track.getSettings?.().displaySurface || "").toLowerCase();
  if (/snapshot studio|recorder\.html|snapshot-studio/.test(label)) return true;
  if (label.includes("recording") && label.includes("snapshot")) return true;
  if ((surface === "browser" || surface === "window") && /recording/.test(label) && /snapshot/.test(label)) {
    return true;
  }
  return false;
}

async function setWin(mode) {
  let win = null;
  try { win = await chrome.windows.getCurrent(); } catch (_) { /* ignore */ }
  if (!win?.id) return;
  try {
    if (mode === "picker") {
      await chrome.windows.update(win.id, { state: "minimized" });
      return;
    }
    const size = mode === "controls"
      ? { width: 360, height: 280 }
      : { width: 420, height: 640 };
    await chrome.windows.update(win.id, {
      state: "normal",
      focused: mode !== "controls",
      ...size,
    });
  } catch (_) { /* ignore */ }
}

async function getDisplayStream(wantAudio) {
  if (params.get("fake") === "1") {
    if (navigator.mediaDevices.getDisplayMedia) {
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: !!wantAudio });
    }
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: !!wantAudio,
    });
  }

  // Hide this window so Chrome's picker is not dominated by it, and so
  // "Entire screen" does not start on our own UI.
  await setWin("picker");
  try {
    const streamId = await pickDesktop(wantAudio);
    const stream = await streamFromDesktopId(streamId, wantAudio);
    if (isRecorderSelfCapture(stream)) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("Pick the screen, window, or page you want in the video — not this Recording window.");
    }
    return stream;
  } finally {
    await setWin(state.startedAt ? "controls" : "studio");
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

function ensureAudioMix() {
  if (state.mixDest) return state.mixedAudio;
  const ctx = new AudioContext();
  state.audioCtx = ctx;
  state.mixDest = ctx.createMediaStreamDestination();
  state.mixedAudio = state.mixDest.stream;
  return state.mixedAudio;
}

function connectAudioStream(stream) {
  if (!stream || !state.audioCtx || !state.mixDest) return;
  stream.getAudioTracks().forEach((track) => {
    const src = state.audioCtx.createMediaStreamSource(new MediaStream([track]));
    src.connect(state.mixDest);
  });
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
  if (video.readyState >= 2 && video.videoWidth > 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const fail = setTimeout(() => {
      cleanup();
      if (video.videoWidth > 2) resolve();
      else reject(new Error("That share never started — pick a different screen, window, or tab."));
    }, 8000);
    const done = () => {
      if (video.videoWidth <= 2) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(fail);
      video.removeEventListener("loadeddata", done);
      video.removeEventListener("playing", done);
    };
    video.addEventListener("loadeddata", done);
    video.addEventListener("playing", done);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback(() => done());
    }
  });
}

function sampleLuma(video) {
  const w = Math.min(160, video.videoWidth | 0);
  const h = Math.min(90, video.videoHeight | 0);
  if (!w || !h) return { mean: 0, max: 0, w: 0, h: 0 };
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let sum = 0;
  let max = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = data[i] + data[i + 1] + data[i + 2];
    sum += y;
    if (y > max) max = y;
  }
  const n = data.length / 4;
  return { mean: sum / n / 3, max: max / 3, w: video.videoWidth, h: video.videoHeight };
}

async function waitLivePreview(video) {
  await waitMeta(video);
  for (let i = 0; i < 12; i++) {
    const s = sampleLuma(video);
    if (s.w > 2 && s.max > 8) return s;
    await new Promise((r) => setTimeout(r, 120));
  }
  const s = sampleLuma(video);
  if (s.w > 2 && s.max > 4) return s;
  throw new Error("Shared screen is blank. Pick a different screen, window, or tab — not this Recording window.");
}

function drawContain(ctx, video, W, H) {
  const vw = video.videoWidth || W;
  const vh = video.videoHeight || H;
  const scale = Math.min(W / vw, H / vh);
  const dw = vw * scale;
  const dh = vh * scale;
  ctx.drawImage(video, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

function drawWaiting(ctx, W, H) {
  ctx.fillStyle = "#0b0d12";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#7c74ff";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2 - 36, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8ebf1";
  ctx.font = "600 28px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Recording", W / 2, H / 2 + 8);
  ctx.fillStyle = "#9ca3af";
  ctx.font = "16px Inter, system-ui, sans-serif";
  ctx.fillText("Share a screen when you are ready", W / 2, H / 2 + 36);
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

function startComposer() {
  const canvas = document.createElement("canvas");
  canvas.width = OUT_W;
  canvas.height = OUT_H;
  const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  state.canvas = canvas;
  state.ctx = ctx;
  state.composing = true;

  const screenEl = $("#screen-preview");
  const camEl = $("#cam-preview");
  const tick = () => {
    if (!state.composing) return;
    if (state.sharing && screenEl.videoWidth > 2) {
      ctx.fillStyle = "#0b0d12";
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      drawContain(ctx, screenEl, OUT_W, OUT_H);
    } else {
      drawWaiting(ctx, OUT_W, OUT_H);
    }
    if (opts.camera && state.camera && camEl.readyState >= 2 && camEl.videoWidth) {
      drawPip(ctx, camEl, OUT_W, OUT_H);
    }
  };
  tick();
  state.composeTimer = setInterval(tick, 1000 / 24);
  return canvas.captureStream(24);
}

function pickMime(hasAudio) {
  const list = hasAudio
    ? ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return list.find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";
}

function stopDisplayTracks() {
  try { state.display?.getTracks().forEach((t) => t.stop()); } catch (_) { /* already ended */ }
  state.display = null;
  const preview = $("#screen-preview");
  preview.srcObject = null;
  preview.classList.remove("is-live");
  state.sharing = false;
  syncShareButtons();
  flags();
  liveStatus();
}

async function attachDisplay(stream) {
  const prev = state.display;
  state.display = stream;
  const screenEl = $("#screen-preview");
  await attachPreview(screenEl, stream);
  await waitLivePreview(screenEl);
  try { prev?.getTracks().forEach((t) => t.stop()); } catch (_) { /* replaced */ }
  state.sharing = true;
  syncShareButtons();
  connectAudioStream(stream);
  stream.getVideoTracks()[0]?.addEventListener("ended", () => {
    if (state.display === stream) {
      stopDisplayTracks();
      toast("Screen share ended — recording is still going.");
    }
  });
  flags();
  liveStatus();
}

async function shareScreen() {
  if (state.finalizing || state.picking || state.starting) return;
  const shareBtns = [$("#btn-share"), $("#btn-share-live")].filter(Boolean);
  shareBtns.forEach((b) => { b.disabled = true; });
  try {
    const stream = await getDisplayStream(opts.systemAudio);
    if (state.finalizing) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    await attachDisplay(stream);
    if (state.startedAt) await setWin("controls");
    toast(state.startedAt ? "Screen is in the recording." : "Screen ready — hit Start when you are.");
  } catch (err) {
    if (state.finalizing) return;
    const cancelled = /cancell|denied|abort|NotAllowed|not this Recording/i.test((err?.name || "") + (err?.message || ""));
    toast(cancelled
      ? (err.message && /not this Recording/i.test(err.message)
        ? err.message
        : (state.startedAt ? "Nothing was shared — recording continues." : "Share cancelled."))
      : (err.message || String(err)));
    if (!cancelled) console.warn("[SnapShot] share", err);
  } finally {
    if (!state.finalizing) shareBtns.forEach((b) => { b.disabled = false; });
  }
}

function hideCountdown() {
  clearTimeout(state.countdownTimer);
  state.countdownTimer = 0;
  const el = $("#countdown");
  if (el) el.hidden = true;
  document.body.classList.remove("is-counting");
}

function runCountdown(seconds = 3) {
  if (params.get("countdown") === "0" || params.get("fake") === "1") {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const root = $("#countdown");
    const num = $("#countdown-num");
    const hint = $("#countdown-hint");
    if (!root || !num) return resolve();

    document.body.classList.add("is-counting");
    root.hidden = false;
    let left = Math.max(1, seconds | 0);
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      hideCountdown();
      if (ok) resolve();
      else reject(new Error("Capture cancelled."));
    };

    const tick = () => {
      if (state.finalizing) return finish(false);
      if (left > 0) {
        num.textContent = String(left);
        num.classList.remove("is-go");
        num.style.animation = "none";
        void num.offsetWidth;
        num.style.animation = "";
        if (hint) {
          hint.textContent = left === 3 ? "Get ready" : left === 2 ? "Looking good" : "Almost there";
        }
        setStatus(`Starting in ${left}…`);
        left -= 1;
        state.countdownTimer = setTimeout(tick, 1000);
        return;
      }
      num.textContent = "GO";
      num.classList.add("is-go");
      num.style.animation = "none";
      void num.offsetWidth;
      num.style.animation = "";
      if (hint) hint.textContent = "You're live";
      setStatus("Starting…");
      state.countdownTimer = setTimeout(() => finish(true), 480);
    };
    tick();
  });
}

async function start() {
  if (state.recorder || state.finalizing || state.starting) return;
  state.starting = true;
  $("#btn-start").disabled = true;
  $("#btn-start").hidden = true;
  setStatus("Get ready…");
  state.finalizing = false;
  state.saved = false;
  state.chunks = [];
  chrome.runtime.sendMessage({ type: "RECORDING_COUNTDOWN" }).catch(() => {});

  try {
    await runCountdown(3);
  } catch (_) {
    state.starting = false;
    setLiveUi(false);
    $("#btn-start").hidden = false;
    $("#btn-start").disabled = false;
    const note = $("#person-off");
    if (note) note.hidden = false;
    liveStatus();
    return;
  }
  if (state.finalizing) {
    state.starting = false;
    return;
  }

  if (opts.camera) {
    try {
      state.camera = await getCamera();
      await attachPreview($("#cam-preview"), state.camera);
      $("#person-panel").hidden = false;
      $("#person-off").hidden = true;
    } catch (err) {
      console.warn("[SnapShot] camera", err);
      opts.camera = false;
      $("#person-panel").hidden = true;
      toast("Camera unavailable — continuing without it.");
    }
  } else {
    $("#person-panel").hidden = true;
  }

  const note = $("#person-off");
  if (note) note.hidden = true;

  const wantAudio = !!(opts.mic || opts.systemAudio);
  if (wantAudio) ensureAudioMix();

  if (opts.mic) {
    try {
      state.mic = await getMic();
      connectAudioStream(state.mic);
    } catch (err) {
      console.warn("[SnapShot] mic", err);
      opts.mic = false;
      toast("Microphone unavailable — continuing without voice.");
    }
  }

  const videoStream = startComposer();
  const tracks = [...videoStream.getVideoTracks()];
  if (state.mixedAudio) tracks.push(...state.mixedAudio.getAudioTracks());
  const out = new MediaStream(tracks);
  const hasAudio = !!(state.mixedAudio && state.mixedAudio.getAudioTracks().length);
  const recOpts = {
    mimeType: pickMime(hasAudio),
    videoBitsPerSecond: bitrateFor(OUT_W, OUT_H),
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

  state.recorder.start(1000);
  state.startedAt = Date.now();
  setLiveUi(true);
  flags();
  liveStatus();
  tickClock();
  state.clock = setInterval(tickClock, 500);
  chrome.runtime.sendMessage({ type: "RECORDING_STARTED", startedAt: state.startedAt }).catch(() => {});
  await setWin("controls");
  state.starting = false;
}

function bitrateFor(w, h) {
  const pixels = (w || 1920) * (h || 1080);
  return Math.round(Math.min(20_000_000, Math.max(8_000_000, pixels * 4)));
}

function tickClock() {
  const s = Math.max(0, Math.floor((Date.now() - state.startedAt) / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  $("#rec-clock").textContent = `${mm}:${ss}`;
}

function stop() {
  if (state.finalizing) return;
  // Allow cancel during the 3-2-1 countdown.
  if (state.starting && !state.recorder) {
    state.finalizing = true;
    hideCountdown();
    state.starting = false;
    stopAll();
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" }).catch(() => {});
    closeRecorderWindow();
    return;
  }
  state.finalizing = true;
  hideCountdown();
  showSaving("Saving your recording…");
  $("#btn-stop").disabled = true;
  setStatus("Saving…");
  cancelSharePicker();
  stopDisplayTracks();
  if (state.recorder && state.recorder.state !== "inactive") {
    try { state.recorder.stop(); } catch (_) { finalize(); }
  } else {
    finalize();
  }
}

function showSaving(title) {
  const el = $("#saving");
  const t = $("#saving-title");
  if (t && title) t.textContent = title;
  if (el) el.hidden = false;
  document.body.classList.add("is-saving");
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

function closeRecorderWindow() {
  // Prefer SW remove — popup windows often ignore window.close().
  chrome.runtime.sendMessage({ type: "CLOSE_RECORDER" }).catch(() => {
    try { window.close(); } catch (_) { /* ignore */ }
  });
}

async function finalize() {
  if (state.saved) return;
  state.saved = true;
  state.finalizing = true;
  cancelSharePicker();
  state.composing = false;
  clearInterval(state.composeTimer);
  clearInterval(state.clock);
  const blob = new Blob(state.chunks || [], { type: "video/webm" });
  state.chunks = [];
  stopAll();
  chrome.runtime.sendMessage({ type: "RECORDING_DONE" }).catch(() => {});
  if (!blob.size) {
    showSaving("Nothing was recorded");
    setStatus("Nothing was recorded");
    toast("Recording was empty — closing…");
    setTimeout(closeRecorderWindow, 800);
    return;
  }
  showSaving("Saving your recording…");
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename: `SnapShot-recording-${stamp}.webm`,
      saveAs: params.get("saveAs") !== "0",
    });
    await waitForDownload(downloadId);
    showSaving("Saved — closing…");
    setStatus("Saved");
    setTimeout(closeRecorderWindow, 450);
  } catch (err) {
    showSaving("Save failed");
    setStatus("Save failed");
    toast("Save failed: " + (err.message || err));
    setTimeout(closeRecorderWindow, 1400);
  }
}

function resetUi() {
  document.body.classList.remove("is-live", "is-saving", "is-counting");
  setLiveUi(false);
  $("#btn-start").hidden = false;
  $("#btn-start").disabled = false;
  $("#btn-share").disabled = false;
  $("#saving").hidden = true;
  state.finalizing = false;
  state.startedAt = 0;
  state.sharing = false;
  syncShareButtons();
  flags();
  liveStatus();
}

function stopAll() {
  cancelSharePicker();
  [state.display, state.camera, state.mic].forEach((s) => {
    try { s?.getTracks().forEach((t) => t.stop()); } catch (_) { /* already ended */ }
  });
  state.display = null;
  state.camera = null;
  state.mic = null;
  state.composing = false;
  state.sharing = false;
  try {
    const preview = $("#screen-preview");
    if (preview) {
      preview.srcObject = null;
      preview.classList.remove("is-live");
    }
  } catch (_) { /* ignore */ }
  try { state.audioCtx?.close(); } catch (_) { /* ignore */ }
  state.audioCtx = null;
  state.mixDest = null;
  state.mixedAudio = null;
  state.recorder = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "RECORDER_STOP") stop();
});

$("#btn-start").addEventListener("click", () => {
  start().catch((err) => {
    state.starting = false;
    setLiveUi(false);
    $("#btn-start").hidden = false;
    $("#btn-start").disabled = false;
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED", error: err.message }).catch(() => {});
    setStatus("Could not start");
    toast(err.message || String(err));
  });
});
$("#btn-share").addEventListener("click", () => { shareScreen(); });
$("#btn-share-live")?.addEventListener("click", () => { shareScreen(); });
$("#btn-unshare").addEventListener("click", () => {
  stopDisplayTracks();
  toast("Screen removed — recording continues.");
});
$("#btn-stop").addEventListener("click", stop);
$("#btn-cancel-count")?.addEventListener("click", () => {
  if (state.starting && !state.recorder) stop();
});
window.addEventListener("beforeunload", () => {
  if (state.recorder && state.recorder.state === "recording") {
    try { state.recorder.stop(); } catch (_) { /* closing */ }
  } else if (!state.startedAt) {
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" }).catch(() => {});
  }
});

syncShareButtons();
flags();
liveStatus();
setLiveUi(false);
window.__recorder = { state, start, shareScreen, stopDisplayTracks, stop };

if (params.get("autostart") === "1") {
  start().catch((err) => {
    state.starting = false;
    toast(err.message || String(err));
    $("#btn-start").hidden = false;
    $("#btn-start").disabled = false;
  });
}
