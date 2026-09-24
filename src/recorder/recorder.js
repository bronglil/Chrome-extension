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
  quality: ["720", "1080", "1440"].includes(params.get("q")) ? params.get("q") : "720",
  pip: ["bl", "bc", "br"].includes(params.get("pip")) ? params.get("pip") : "bc",
  blur: params.get("blur") === "1",
  cues: params.get("cues") !== "0",
};

const QUALITY = {
  "720": { w: 1280, h: 720 },
  "1080": { w: 1920, h: 1080 },
  "1440": { w: 2560, h: 1440 },
};
const OUT = QUALITY[opts.quality] || QUALITY["720"];
const OUT_W = OUT.w;
const OUT_H = OUT.h;

const PIP_ORDER = ["bc", "br", "bl"];

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
  pausedAt: 0,
  pausedMs: 0,
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
  paused: false,
  micMuted: false,
  camOff: false,
  discard: false,
  pip: opts.pip,
  blurBg: !!opts.blur,
  pipScratch: null,
  pipScratchCtx: null,
  pipMask: null,
  pipMaskCtx: null,
  inkTool: null, // null | pen | marker | eraser
  inkColor: "#ef4444",
  inkStrokes: [],
  inkCurrent: null,
  inkOpen: false,
  cuesOn: !!opts.cues,
  ripples: [],
  keyBadges: [],
  trimBlob: null,
  trimUrl: null,
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
    { label: opts.camera && state.camera && !state.camOff ? "Camera on" : "Camera off", on: !!(opts.camera && state.camera && !state.camOff) },
    { label: opts.mic && state.mic ? (state.micMuted ? "Mic muted" : "Mic on") : "Mic off", on: !!(opts.mic && state.mic && !state.micMuted) },
    {
      label: opts.systemAudio && state.display?.getAudioTracks().length ? "System audio" : "No system audio",
      on: !!(opts.systemAudio && state.display?.getAudioTracks().length),
    },
    { label: `${opts.quality}p`, on: true },
    { label: state.blurBg ? "Blur on" : "Blur off", on: !!state.blurBg },
    { label: state.cuesOn ? "Cues on" : "Cues off", on: !!state.cuesOn },
  ];
  $("#flags").innerHTML = bits.map((b) => {
    const cls = ["flag", b.on ? "is-on" : "", b.live ? "is-live" : ""].filter(Boolean).join(" ");
    return `<span class="${cls}">${b.label}</span>`;
  }).join("");
}

function syncShareButtons() {
  const label = state.sharing ? "Change screen" : "Share screen";
  const liveLabel = state.sharing ? "Change" : "Share";
  const shareLabel = $("#share-label");
  const shareLabelLive = $("#share-label-live");
  if (shareLabel) shareLabel.textContent = label;
  if (shareLabelLive) shareLabelLive.textContent = liveLabel;
  $("#btn-unshare").hidden = !state.sharing || !!state.startedAt;
  $("#screen-empty").hidden = state.sharing;
  $("#screen-preview").classList.toggle("is-live", state.sharing);
}

function syncPipUi() {
  const panel = $("#person-panel");
  if (!panel) return;
  panel.classList.remove("pip--bl", "pip--bc", "pip--br");
  panel.classList.add(`pip--${state.pip || "bc"}`);
}

function syncToggleUi() {
  const pauseBtn = $("#btn-pause");
  if (pauseBtn) {
    pauseBtn.classList.toggle("is-paused", state.paused);
    const pauseIco = pauseBtn.querySelector(".ico-pause");
    const playIco = pauseBtn.querySelector(".ico-play");
    if (pauseIco) pauseIco.hidden = state.paused;
    if (playIco) playIco.hidden = !state.paused;
    pauseBtn.title = state.paused ? "Resume" : "Pause";
  }
  const micBtn = $("#btn-mic");
  if (micBtn) {
    micBtn.hidden = !(opts.mic && state.mic);
    micBtn.classList.toggle("is-off", state.micMuted);
    const on = micBtn.querySelector(".ico-mic-on");
    const off = micBtn.querySelector(".ico-mic-off");
    if (on) on.hidden = state.micMuted;
    if (off) off.hidden = !state.micMuted;
  }
  const camBtn = $("#btn-cam");
  if (camBtn) {
    camBtn.hidden = !(opts.camera && state.camera);
    camBtn.classList.toggle("is-off", state.camOff);
    const on = camBtn.querySelector(".ico-cam-on");
    const off = camBtn.querySelector(".ico-cam-off");
    if (on) on.hidden = state.camOff;
    if (off) off.hidden = !state.camOff;
  }
  const pipBtn = $("#btn-pip-pos");
  if (pipBtn) pipBtn.hidden = !(opts.camera && state.camera && !state.camOff);
  const blurBtn = $("#btn-blur");
  if (blurBtn) {
    blurBtn.hidden = !(opts.camera && state.camera && !state.camOff);
    blurBtn.classList.toggle("is-on", state.blurBg);
    blurBtn.title = state.blurBg ? "Turn off background blur" : "Blur camera background";
  }
  const annBtn = $("#btn-annotate");
  if (annBtn) {
    annBtn.hidden = !state.startedAt;
    annBtn.classList.toggle("is-on", !!state.inkOpen || !!state.inkTool);
    annBtn.title = state.inkOpen ? "Hide draw tools" : "Draw on recording";
  }
  const cuesBtn = $("#btn-cues");
  if (cuesBtn) {
    cuesBtn.hidden = !state.startedAt;
    cuesBtn.classList.toggle("is-on", !!state.cuesOn);
    cuesBtn.title = state.cuesOn ? "Hide click & key cues" : "Show click & key cues";
  }
  const banner = $("#paused-banner");
  if (banner) banner.hidden = !state.paused;
  $("#live-chip")?.classList.toggle("is-paused", state.paused);
  if (opts.camera && state.camera) {
    $("#person-panel").hidden = state.camOff;
    $("#person-panel")?.classList.toggle("is-blur", state.blurBg && !state.camOff);
  }
  syncPipUi();
  syncInkUi();
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
  } else {
    state.inkOpen = false;
    state.inkTool = null;
    state.inkCurrent = null;
  }
  syncToggleUi();
}

function liveStatus() {
  if (state.starting && !state.startedAt) return setStatus("Countdown…");
  if (!state.startedAt) return setStatus("Ready to record");
  if (state.paused) return setStatus("Paused — resume when ready");
  if (state.sharing && opts.camera && state.camera && !state.camOff) return setStatus("Screen + camera · live");
  if (state.sharing) return setStatus("Screen shared · live");
  if (opts.camera && state.camera && !state.camOff) return setStatus("Camera only · share anytime");
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
  ctx.fillStyle = state.paused ? "#fbbf24" : "#7c74ff";
  ctx.beginPath();
  ctx.arc(W / 2, H / 2 - 36, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8ebf1";
  ctx.font = "600 28px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(state.paused ? "Paused" : "Recording", W / 2, H / 2 + 8);
  ctx.fillStyle = "#9ca3af";
  ctx.font = "16px Inter, system-ui, sans-serif";
  ctx.fillText(
    state.paused ? "Resume when you are ready" : "Share a screen when you are ready",
    W / 2,
    H / 2 + 36
  );
}

function ensurePipBuffers(w, h) {
  if (state.pipScratch && state.pipScratch.width === w && state.pipScratch.height === h) return;
  state.pipScratch = document.createElement("canvas");
  state.pipScratch.width = w;
  state.pipScratch.height = h;
  state.pipScratchCtx = state.pipScratch.getContext("2d", { alpha: true });
  state.pipMask = document.createElement("canvas");
  state.pipMask.width = w;
  state.pipMask.height = h;
  state.pipMaskCtx = state.pipMask.getContext("2d", { alpha: true });
}

function drawCamMirrored(destCtx, cam, w, h) {
  destCtx.save();
  destCtx.translate(w, 0);
  destCtx.scale(-1, 1);
  destCtx.drawImage(cam, 0, 0, w, h);
  destCtx.restore();
}

function renderBlurredPip(cam, pipW, pipH) {
  ensurePipBuffers(pipW, pipH);
  const soft = state.pipScratchCtx;
  const sharp = state.pipMaskCtx;
  const blurPx = Math.max(10, Math.round(pipW * 0.08));

  soft.clearRect(0, 0, pipW, pipH);
  soft.filter = `blur(${blurPx}px)`;
  soft.imageSmoothingEnabled = true;
  drawCamMirrored(soft, cam, pipW, pipH);
  soft.filter = "none";

  sharp.clearRect(0, 0, pipW, pipH);
  drawCamMirrored(sharp, cam, pipW, pipH);
  sharp.globalCompositeOperation = "destination-in";
  const g = sharp.createRadialGradient(
    pipW * 0.5,
    pipH * 0.42,
    pipW * 0.16,
    pipW * 0.5,
    pipH * 0.48,
    pipW * 0.52
  );
  g.addColorStop(0, "rgba(0,0,0,1)");
  g.addColorStop(0.5, "rgba(0,0,0,0.92)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  sharp.fillStyle = g;
  sharp.fillRect(0, 0, pipW, pipH);
  sharp.globalCompositeOperation = "source-over";

  soft.drawImage(state.pipMask, 0, 0);
  return state.pipScratch;
}

function drawPip(ctx, cam, W, H) {
  if (state.camOff) return;
  const pipW = Math.round(Math.min(W * 0.22, 420));
  const pipH = Math.round(pipW * (cam.videoHeight && cam.videoWidth ? cam.videoHeight / cam.videoWidth : 0.75));
  const margin = Math.round(H * 0.04);
  const pos = state.pip || "bc";
  let x;
  if (pos === "bl") x = margin;
  else if (pos === "br") x = W - pipW - margin;
  else x = Math.round((W - pipW) / 2);
  const y = H - pipH - margin;
  const r = Math.min(22, pipW / 8);
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, pipW, pipH, r);
  ctx.clip();
  if (state.blurBg) {
    ctx.drawImage(renderBlurredPip(cam, pipW, pipH), x, y);
  } else {
    ctx.translate(x + pipW, y);
    ctx.scale(-1, 1);
    ctx.drawImage(cam, 0, 0, pipW, pipH);
  }
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.92)";
  ctx.lineWidth = Math.max(3, Math.round(W / 480));
  ctx.beginPath();
  ctx.roundRect(x, y, pipW, pipH, r);
  ctx.stroke();
  ctx.restore();
}

/* -------------------------------------------------------------------------- */
/* Annotate while recording — ink in compositor (screen → ink → PiP)          */
/* -------------------------------------------------------------------------- */

function inkStyle(tool) {
  const scale = OUT_W / 1280;
  if (tool === "marker") {
    return { width: Math.max(14, 22 * scale), opacity: 0.42, lineCap: "round" };
  }
  return { width: Math.max(2.5, 3.5 * scale), opacity: 1, lineCap: "round" };
}

function eraserRadius() {
  return Math.max(16, 22 * (OUT_W / 1280));
}

function drawStrokePath(ctx, stroke) {
  const pts = stroke.points;
  if (!pts || pts.length < 2) return;
  const style = inkStyle(stroke.tool);
  ctx.save();
  ctx.globalAlpha = stroke.opacity != null ? stroke.opacity : style.opacity;
  ctx.strokeStyle = stroke.color;
  ctx.lineWidth = stroke.width != null ? stroke.width : style.width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.stroke();
  ctx.restore();
}

function drawInkLayer(ctx) {
  for (const s of state.inkStrokes) drawStrokePath(ctx, s);
  if (state.inkCurrent) drawStrokePath(ctx, state.inkCurrent);
}

function paintInkOverlay() {
  const canvas = $("#ink-overlay");
  if (!canvas) return;
  const preview = $("#preview");
  const rect = preview.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!state.inkStrokes.length && !state.inkCurrent && !state.ripples.length && !state.keyBadges.length) return;
  ctx.save();
  ctx.scale(w / OUT_W, h / OUT_H);
  drawInkLayer(ctx);
  drawCuesLayer(ctx, OUT_W, OUT_H);
  ctx.restore();
}

function clientToInk(clientX, clientY) {
  const preview = $("#preview");
  const rect = preview.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return null;
  const x = ((clientX - rect.left) / rect.width) * OUT_W;
  const y = ((clientY - rect.top) / rect.height) * OUT_H;
  return {
    x: Math.max(0, Math.min(OUT_W, x)),
    y: Math.max(0, Math.min(OUT_H, y)),
  };
}

function strokeNearPoint(stroke, x, y, radius) {
  const pts = stroke.points;
  const r2 = radius * radius;
  for (let i = 0; i < pts.length; i += 2) {
    const dx = pts[i] - x;
    const dy = pts[i + 1] - y;
    if (dx * dx + dy * dy <= r2) return true;
  }
  return false;
}

function eraseAt(x, y) {
  const r = eraserRadius();
  const before = state.inkStrokes.length;
  state.inkStrokes = state.inkStrokes.filter((s) => !strokeNearPoint(s, x, y, r));
  return state.inkStrokes.length !== before;
}

function syncInkUi() {
  const dock = $("#annotate-dock");
  const hit = $("#ink-hit");
  if (dock) dock.hidden = !state.inkOpen || !state.startedAt;
  document.querySelectorAll(".annotate__tool").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.tool === state.inkTool);
  });
  document.querySelectorAll(".annotate__swatch").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.color === state.inkColor);
  });
  if (hit) {
    const drawing = !!state.inkTool && !!state.startedAt && !state.paused;
    hit.hidden = !drawing;
    hit.classList.toggle("is-eraser", state.inkTool === "eraser");
  }
  paintInkOverlay();
}

function setInkTool(tool) {
  if (!state.startedAt) return;
  if (tool && !["pen", "marker", "eraser"].includes(tool)) return;
  state.inkTool = tool || null;
  state.inkOpen = true;
  if (state.inkCurrent) {
    if (state.inkCurrent.points.length >= 4) state.inkStrokes.push(state.inkCurrent);
    state.inkCurrent = null;
  }
  syncToggleUi();
}

function setInkColor(color) {
  if (!color) return;
  state.inkColor = color;
  if (state.inkTool === "eraser") state.inkTool = "pen";
  state.inkOpen = true;
  syncInkUi();
}

function clearInk() {
  state.inkStrokes = [];
  state.inkCurrent = null;
  paintInkOverlay();
  toast("Annotations cleared");
}

function closeInkMode() {
  if (state.inkCurrent) {
    if (state.inkCurrent.points.length >= 4) state.inkStrokes.push(state.inkCurrent);
    state.inkCurrent = null;
  }
  state.inkTool = null;
  state.inkOpen = false;
  syncToggleUi();
}

function toggleAnnotateDock() {
  if (!state.startedAt) return;
  if (state.inkOpen) {
    closeInkMode();
  } else {
    state.inkOpen = true;
    if (!state.inkTool) state.inkTool = "pen";
    syncToggleUi();
  }
}

function onInkPointerDown(e) {
  if (!state.inkTool || state.paused || !state.startedAt) return;
  e.preventDefault();
  const pt = clientToInk(e.clientX, e.clientY);
  if (!pt) return;
  spawnRipple(pt.x, pt.y);
  const hit = $("#ink-hit");
  hit?.setPointerCapture?.(e.pointerId);
  if (state.inkTool === "eraser") {
    eraseAt(pt.x, pt.y);
    paintInkOverlay();
    state.inkCurrent = { tool: "eraser", points: [pt.x, pt.y] };
    return;
  }
  const style = inkStyle(state.inkTool);
  state.inkCurrent = {
    tool: state.inkTool,
    color: state.inkColor,
    width: style.width,
    opacity: style.opacity,
    points: [pt.x, pt.y],
  };
  paintInkOverlay();
}

function onInkPointerMove(e) {
  if (!state.inkCurrent || state.paused) return;
  const pt = clientToInk(e.clientX, e.clientY);
  if (!pt) return;
  const pts = state.inkCurrent.points;
  const lx = pts[pts.length - 2];
  const ly = pts[pts.length - 1];
  if (Math.hypot(pt.x - lx, pt.y - ly) < 1.5) return;
  if (state.inkCurrent.tool === "eraser") {
    eraseAt(pt.x, pt.y);
    pts.push(pt.x, pt.y);
    paintInkOverlay();
    return;
  }
  pts.push(pt.x, pt.y);
  paintInkOverlay();
}

function onInkPointerUp() {
  if (!state.inkCurrent) return;
  if (state.inkCurrent.tool !== "eraser" && state.inkCurrent.points.length >= 4) {
    state.inkStrokes.push(state.inkCurrent);
  }
  state.inkCurrent = null;
  paintInkOverlay();
}

/* -------------------------------------------------------------------------- */
/* Click ripples + key badges (#41) — compositor cues                         */
/* -------------------------------------------------------------------------- */

const RIPPLE_MS = 520;
const BADGE_MS = 1100;

function spawnRipple(x, y) {
  if (!state.cuesOn || !state.startedAt || state.paused) return;
  state.ripples.push({ x, y, t0: performance.now() });
  if (state.ripples.length > 12) state.ripples.shift();
}

function spawnBadge(label) {
  if (!state.cuesOn || !state.startedAt || state.paused || !label) return;
  const last = state.keyBadges[state.keyBadges.length - 1];
  if (last && last.label === label && performance.now() - last.t0 < 180) return;
  state.keyBadges.push({ label, t0: performance.now() });
  if (state.keyBadges.length > 4) state.keyBadges.shift();
}

function pruneCues(now) {
  state.ripples = state.ripples.filter((r) => now - r.t0 < RIPPLE_MS);
  state.keyBadges = state.keyBadges.filter((b) => now - b.t0 < BADGE_MS);
}

function drawCuesLayer(ctx, W, H) {
  const now = performance.now();
  pruneCues(now);
  for (const r of state.ripples) {
    const p = Math.min(1, (now - r.t0) / RIPPLE_MS);
    const radius = 10 + p * Math.max(36, W * 0.035);
    ctx.save();
    ctx.beginPath();
    ctx.arc(r.x, r.y, radius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${(1 - p) * 0.85})`;
    ctx.lineWidth = Math.max(2.5, W / 420);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(r.x, r.y, Math.max(3, radius * 0.22), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(99,102,241,${(1 - p) * 0.55})`;
    ctx.fill();
    ctx.restore();
  }
  if (!state.keyBadges.length) return;
  const badge = state.keyBadges[state.keyBadges.length - 1];
  const p = Math.min(1, (now - badge.t0) / BADGE_MS);
  const alpha = p < 0.15 ? p / 0.15 : p > 0.7 ? (1 - p) / 0.3 : 1;
  const padX = Math.max(18, W * 0.018);
  const padY = Math.max(10, H * 0.012);
  const fontSize = Math.max(18, Math.round(W * 0.022));
  ctx.save();
  ctx.font = `700 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const tw = ctx.measureText(badge.label).width;
  const bw = tw + padX * 2;
  const bh = fontSize + padY * 2;
  const bx = W / 2 - bw / 2;
  const by = H - Math.max(48, H * 0.08) - bh;
  const rr = Math.min(14, bh / 2);
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.fillStyle = "rgba(17,24,39,0.82)";
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, rr);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = "#f3f4f6";
  ctx.fillText(badge.label, W / 2, by + bh / 2);
  ctx.restore();
}

function keyBadgeLabel(e) {
  if (e.repeat) return null;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || "");
  const mod = [];
  if (e.metaKey) mod.push(isMac ? "⌘" : "Win");
  if (e.ctrlKey) mod.push(isMac ? "Ctrl" : "Ctrl");
  if (e.altKey) mod.push(isMac ? "⌥" : "Alt");
  if (e.shiftKey && (e.metaKey || e.ctrlKey || e.altKey || /^Arrow|Enter|Tab|Escape|Backspace|Delete|Home|End|Page/.test(e.key))) {
    mod.push("⇧");
  }

  const special = {
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "⌫",
    Delete: "Del",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Home: "Home",
    End: "End",
    PageUp: "PgUp",
    PageDown: "PgDn",
    " ": "Space",
  };

  if (special[e.key]) {
    // Bare modifier keys alone
    if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return null;
    return mod.length ? `${mod.join("")}${special[e.key]}` : special[e.key];
  }

  // Only letter/digit keys when a non-shift modifier is held (shortcuts, not typing).
  if ((e.metaKey || e.ctrlKey || e.altKey) && e.key.length === 1) {
    const k = e.key.toUpperCase();
    if (e.shiftKey && !mod.includes("⇧")) mod.push("⇧");
    return `${mod.join("")}${k}`;
  }
  return null;
}

function toggleCues() {
  if (!state.startedAt) return;
  state.cuesOn = !state.cuesOn;
  if (!state.cuesOn) {
    state.ripples = [];
    state.keyBadges = [];
  }
  syncToggleUi();
  flags();
  toast(state.cuesOn ? "Click & key cues on" : "Click & key cues off");
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
    // Ink between screen and camera PiP so annotations stay under the presenter bubble.
    drawInkLayer(ctx);
    drawCuesLayer(ctx, OUT_W, OUT_H);
    if (opts.camera && state.camera && !state.camOff && camEl.readyState >= 2 && camEl.videoWidth) {
      drawPip(ctx, camEl, OUT_W, OUT_H);
    }
    // Keep studio overlay in sync with animated cues.
    if (state.cuesOn && (state.ripples.length || state.keyBadges.length || state.inkStrokes.length || state.inkCurrent)) {
      paintInkOverlay();
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
  state.paused = false;
  state.pausedAt = 0;
  state.pausedMs = 0;
  state.micMuted = false;
  state.camOff = false;
  state.discard = false;
  state.inkStrokes = [];
  state.inkCurrent = null;
  state.inkTool = null;
  state.inkOpen = false;
  state.inkColor = "#ef4444";
  state.cuesOn = !!opts.cues;
  state.ripples = [];
  state.keyBadges = [];
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

function elapsedMs() {
  if (!state.startedAt) return 0;
  const pausedExtra = state.paused && state.pausedAt ? Date.now() - state.pausedAt : 0;
  return Math.max(0, Date.now() - state.startedAt - state.pausedMs - pausedExtra);
}

function tickClock() {
  const s = Math.floor(elapsedMs() / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  $("#rec-clock").textContent = `${mm}:${ss}`;
}

function togglePause() {
  if (!state.recorder || state.finalizing || !state.startedAt) return;
  try {
    if (state.paused) {
      if (state.recorder.state === "paused") state.recorder.resume();
      if (state.pausedAt) state.pausedMs += Date.now() - state.pausedAt;
      state.pausedAt = 0;
      state.paused = false;
      toast("Recording resumed");
    } else {
      if (state.recorder.state === "recording") state.recorder.pause();
      state.paused = true;
      state.pausedAt = Date.now();
      toast("Paused");
    }
  } catch (err) {
    toast(err.message || "Pause unavailable");
    return;
  }
  syncToggleUi();
  liveStatus();
  tickClock();
}

function toggleMicMute() {
  if (!state.mic) return;
  state.micMuted = !state.micMuted;
  state.mic.getAudioTracks().forEach((t) => { t.enabled = !state.micMuted; });
  syncToggleUi();
  flags();
  toast(state.micMuted ? "Microphone muted" : "Microphone on");
}

function toggleCamera() {
  if (!state.camera) return;
  state.camOff = !state.camOff;
  state.camera.getVideoTracks().forEach((t) => { t.enabled = !state.camOff; });
  syncToggleUi();
  flags();
  liveStatus();
  toast(state.camOff ? "Camera hidden" : "Camera on");
}

function cyclePip() {
  if (!(opts.camera && state.camera) || state.camOff) return;
  const i = PIP_ORDER.indexOf(state.pip);
  state.pip = PIP_ORDER[(i + 1) % PIP_ORDER.length];
  syncPipUi();
  const labels = { bc: "bottom center", br: "bottom right", bl: "bottom left" };
  toast(`Camera · ${labels[state.pip] || state.pip}`);
}

function toggleBlur() {
  if (!(opts.camera && state.camera) || state.camOff) return;
  state.blurBg = !state.blurBg;
  syncToggleUi();
  flags();
  toast(state.blurBg ? "Background blur on" : "Background blur off");
}

function discard() {
  if (state.finalizing || !state.startedAt) return;
  state.discard = true;
  toast("Discarding…");
  stop();
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
  showSaving(state.discard ? "Discarding…" : "Saving your recording…");
  $("#btn-stop").disabled = true;
  setStatus(state.discard ? "Discarding…" : "Saving…");
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

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const mm = String(Math.floor(s / 60)).padStart(1, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function shouldSkipTrimUi() {
  // fake=1 e2e paths expect an immediate download on Stop.
  // Pass trim=1 with fake=1 to force the review UI in tests.
  if (params.get("trim") === "1") return false;
  if (params.get("trim") === "0") return true;
  if (params.get("fake") === "1") return true;
  return false;
}

function syncTrimLabels() {
  const video = $("#trim-video");
  const startEl = $("#trim-start");
  const endEl = $("#trim-end");
  if (!video || !startEl || !endEl) return;
  const dur = video.duration || 0;
  if (!Number.isFinite(dur) || dur <= 0) return;
  let start = (+startEl.value / 1000) * dur;
  let end = (+endEl.value / 1000) * dur;
  if (end - start < 0.25) {
    if (startEl === document.activeElement) end = Math.min(dur, start + 0.25);
    else start = Math.max(0, end - 0.25);
    startEl.value = String(Math.round((start / dur) * 1000));
    endEl.value = String(Math.round((end / dur) * 1000));
  }
  $("#trim-times").textContent = `${fmtTime(start)} – ${fmtTime(end)} · ${fmtTime(end - start)} selected`;
  if (Math.abs(video.currentTime - start) > 0.35 && !video._scrubbing) {
    video.currentTime = start;
  }
}

function getTrimRange() {
  const video = $("#trim-video");
  const dur = video?.duration || 0;
  const start = ((+$("#trim-start").value) / 1000) * dur;
  const end = ((+$("#trim-end").value) / 1000) * dur;
  return {
    start: Math.max(0, start),
    end: Math.min(dur, Math.max(start + 0.25, end)),
    duration: dur,
  };
}

function closeTrimPanel() {
  const video = $("#trim-video");
  try { video?.pause(); } catch (_) { /* ignore */ }
  if (video) {
    video.removeAttribute("src");
    video.load();
  }
  if (state.trimUrl) {
    try { URL.revokeObjectURL(state.trimUrl); } catch (_) { /* ignore */ }
  }
  state.trimUrl = null;
  state.trimBlob = null;
  $("#trim-panel").hidden = true;
  document.body.classList.remove("is-trimming");
}

/**
 * Trim by local re-encode: play the source WebM from start→end while
 * MediaRecorder captures `HTMLMediaElement.captureStream()`. No ffmpeg,
 * fully offline. Documented approach for #42.
 *
 * Video is muted so Chrome's autoplay policy allows play() after async seek
 * (critical under CI / Xvfb where there is no sticky user-gesture).
 */
function trimWebmBlob(blob, startSec, endSec) {
  return new Promise(async (resolve, reject) => {
    const video = document.createElement("video");
    video.playsInline = true;
    video.muted = true;
    video.defaultMuted = true;
    video.volume = 0;
    video.preload = "auto";
    video.setAttribute("muted", "");
    video.style.cssText = "position:fixed;left:-99999px;top:0;width:160px;height:90px;opacity:0;pointer-events:none";
    document.body.appendChild(video);
    const src = URL.createObjectURL(blob);
    video.src = src;

    const cleanup = () => {
      try { URL.revokeObjectURL(src); } catch (_) { /* ignore */ }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video.remove();
      } catch (_) { /* ignore */ }
    };

    try {
      await new Promise((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error("Could not load recording for trim"));
      });
      await fixWebmDuration(video);
      let dur = video.duration || 0;
      if (!Number.isFinite(dur) || dur <= 0) {
        // Last resort: use caller end as duration bound.
        dur = Math.max(endSec, startSec + 0.5, 1);
      }
      const start = Math.max(0, Math.min(startSec, Math.max(0, dur - 0.25)));
      const end = Math.min(dur, Math.max(start + 0.25, endSec));

      await new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error("Seek timed out")), 4000);
        const onSeeked = () => {
          clearTimeout(t);
          video.removeEventListener("seeked", onSeeked);
          res();
        };
        video.addEventListener("seeked", onSeeked);
        try {
          video.currentTime = start;
        } catch (err) {
          clearTimeout(t);
          rej(err);
        }
      });
      // Confirm we actually landed near the trim start.
      if (Math.abs(video.currentTime - start) > 0.5) {
        video.currentTime = start;
        await new Promise((r) => setTimeout(r, 120));
      }

      if (typeof video.captureStream !== "function") {
        cleanup();
        return reject(new Error("Trim is not supported in this browser"));
      }

      const stream = video.captureStream();
      if (!stream.getVideoTracks().length) {
        cleanup();
        return reject(new Error("Trim capture stream has no video track"));
      }
      const mime = pickMime(!!stream.getAudioTracks().length);
      let rec;
      try {
        rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(OUT_W, OUT_H) });
      } catch (_) {
        rec = new MediaRecorder(stream);
      }
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
      const stopped = new Promise((res) => {
        rec.onstop = () => res(new Blob(chunks, { type: "video/webm" }));
        rec.onerror = () => res(new Blob(chunks, { type: "video/webm" }));
      });

      rec.start(100);
      try {
        await video.play();
      } catch (err) {
        try { if (rec.state !== "inactive") rec.stop(); } catch (_) { /* ignore */ }
        cleanup();
        return reject(new Error("Trim playback failed: " + (err.message || err)));
      }

      await new Promise((res) => {
        const tick = () => {
          if (video.ended || video.currentTime >= end - 0.02) {
            try { video.pause(); } catch (_) { /* ignore */ }
            try { if (rec.state !== "inactive") rec.stop(); } catch (_) { /* ignore */ }
            res();
            return;
          }
          requestAnimationFrame(tick);
        };
        tick();
        // Hard stop so a stuck play cannot hang forever.
        setTimeout(() => {
          try { video.pause(); } catch (_) { /* ignore */ }
          try { if (rec.state !== "inactive") rec.stop(); } catch (_) { /* ignore */ }
          res();
        }, Math.ceil((end - start + 2) * 1000));
      });

      const out = await stopped;
      cleanup();
      if (!out.size) return reject(new Error("Trim produced an empty file"));
      resolve({ blob: out, duration: end - start });
    } catch (err) {
      cleanup();
      reject(err);
    }
  });
}

async function downloadRecordingBlob(blob) {
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
  } finally {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }
}

function fixWebmDuration(video) {
  return new Promise((resolve) => {
    if (!video) return resolve(0);
    const done = () => {
      const d = video.duration;
      resolve(Number.isFinite(d) && d > 0 ? d : 0);
    };
    if (Number.isFinite(video.duration) && video.duration > 0) return done();
    // MediaRecorder WebMs often expose Infinity until a huge seek forces the index.
    const onTime = () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("loadedmetadata", onMeta);
      try { video.currentTime = 0; } catch (_) { /* ignore */ }
      done();
    };
    const onMeta = () => {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.removeEventListener("timeupdate", onTime);
        video.removeEventListener("loadedmetadata", onMeta);
        done();
      }
    };
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("loadedmetadata", onMeta);
    try {
      video.currentTime = 1e101;
    } catch (_) {
      done();
    }
    setTimeout(done, 2500);
  });
}

function openTrimReview(blob) {
  state.trimBlob = blob;
  state.trimUrl = URL.createObjectURL(blob);
  const video = $("#trim-video");
  const panel = $("#trim-panel");
  $("#saving").hidden = true;
  document.body.classList.remove("is-saving");
  document.body.classList.add("is-trimming");
  panel.hidden = false;
  video.src = state.trimUrl;
  video.onloadedmetadata = async () => {
    await fixWebmDuration(video);
    $("#trim-start").value = "0";
    $("#trim-end").value = "1000";
    syncTrimLabels();
    try { video.currentTime = 0; } catch (_) { /* ignore */ }
  };
  setStatus("Trim your recording");
}

async function finalize() {
  if (state.saved) return;
  state.saved = true;
  state.finalizing = true;
  cancelSharePicker();
  state.composing = false;
  clearInterval(state.composeTimer);
  clearInterval(state.clock);
  const discarded = !!state.discard;
  const blob = discarded ? null : new Blob(state.chunks || [], { type: "video/webm" });
  state.chunks = [];
  stopAll();
  chrome.runtime.sendMessage({ type: discarded ? "RECORDING_CANCELLED" : "RECORDING_DONE" }).catch(() => {});
  if (discarded) {
    showSaving("Discarded — closing…");
    setStatus("Discarded");
    setTimeout(closeRecorderWindow, 450);
    return;
  }
  if (!blob.size) {
    showSaving("Nothing was recorded");
    setStatus("Nothing was recorded");
    toast("Recording was empty — closing…");
    setTimeout(closeRecorderWindow, 800);
    return;
  }
  if (shouldSkipTrimUi()) {
    showSaving("Saving your recording…");
    await downloadRecordingBlob(blob);
    return;
  }
  openTrimReview(blob);
}

$("#trim-start")?.addEventListener("input", syncTrimLabels);
$("#trim-end")?.addEventListener("input", syncTrimLabels);
$("#trim-discard")?.addEventListener("click", () => {
  closeTrimPanel();
  showSaving("Discarded — closing…");
  setStatus("Discarded");
  setTimeout(closeRecorderWindow, 450);
});
$("#trim-full")?.addEventListener("click", async () => {
  const blob = state.trimBlob;
  if (!blob) return;
  closeTrimPanel();
  showSaving("Saving your recording…");
  await downloadRecordingBlob(blob);
});
$("#trim-save")?.addEventListener("click", async () => {
  const blob = state.trimBlob;
  if (!blob) return;
  const { start, end, duration } = getTrimRange();
  if (!Number.isFinite(duration) || duration <= 0) {
    toast("Recording length unknown — saving full file");
    closeTrimPanel();
    showSaving("Saving your recording…");
    await downloadRecordingBlob(blob);
    return;
  }
  const almostFull = start <= 0.05 && end >= duration - 0.05;
  closeTrimPanel();
  if (almostFull) {
    showSaving("Saving your recording…");
    await downloadRecordingBlob(blob);
    return;
  }
  showSaving("Trimming…");
  setStatus("Trimming…");
  try {
    const { blob: trimmed } = await trimWebmBlob(blob, start, end);
    showSaving("Saving trimmed clip…");
    await downloadRecordingBlob(trimmed);
  } catch (err) {
    console.warn("[SnapShot] trim", err);
    // Don't silently ship the full recording — reopen so the user can Save full.
    showSaving("Trim failed");
    setStatus("Trim failed");
    toast((err && err.message) || "Trim failed — use Save full, or try again");
    $("#saving").hidden = true;
    document.body.classList.remove("is-saving");
    openTrimReview(blob);
  }
});

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
$("#btn-pause")?.addEventListener("click", togglePause);
$("#btn-mic")?.addEventListener("click", toggleMicMute);
$("#btn-cam")?.addEventListener("click", toggleCamera);
$("#btn-pip-pos")?.addEventListener("click", cyclePip);
$("#btn-blur")?.addEventListener("click", toggleBlur);
$("#btn-annotate")?.addEventListener("click", toggleAnnotateDock);
$("#btn-cues")?.addEventListener("click", toggleCues);
$("#btn-discard")?.addEventListener("click", discard);
$("#btn-cancel-count")?.addEventListener("click", () => {
  if (state.starting && !state.recorder) stop();
});

document.querySelectorAll(".annotate__tool").forEach((btn) => {
  btn.addEventListener("click", () => {
    setInkTool(btn.dataset.tool);
  });
});
document.querySelectorAll(".annotate__swatch").forEach((btn) => {
  btn.addEventListener("click", () => setInkColor(btn.dataset.color));
});
$("#ink-clear")?.addEventListener("click", clearInk);
$("#ink-done")?.addEventListener("click", closeInkMode);

const inkHit = $("#ink-hit");
inkHit?.addEventListener("pointerdown", onInkPointerDown);
inkHit?.addEventListener("pointermove", onInkPointerMove);
inkHit?.addEventListener("pointerup", onInkPointerUp);
inkHit?.addEventListener("pointercancel", onInkPointerUp);
window.addEventListener("resize", () => paintInkOverlay());
$("#preview")?.addEventListener("pointerdown", (e) => {
  if (!state.cuesOn || !state.startedAt || state.paused || state.inkTool) return;
  if (e.target.closest?.("#person-panel, .paused-banner, #ink-hit")) return;
  const pt = clientToInk(e.clientX, e.clientY);
  if (pt) spawnRipple(pt.x, pt.y);
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && (state.inkOpen || state.inkTool)) {
    e.preventDefault();
    closeInkMode();
  }
  const label = keyBadgeLabel(e);
  if (label) spawnBadge(label);
});

window.addEventListener("beforeunload", () => {
  if (state.recorder && (state.recorder.state === "recording" || state.recorder.state === "paused")) {
    try { state.recorder.stop(); } catch (_) { /* closing */ }
  } else if (!state.startedAt) {
    chrome.runtime.sendMessage({ type: "RECORDING_CANCELLED" }).catch(() => {});
  }
});

syncShareButtons();
flags();
liveStatus();
setLiveUi(false);
syncPipUi();
window.__recorder = {
  state,
  opts,
  start,
  shareScreen,
  stopDisplayTracks,
  stop,
  togglePause,
  toggleMicMute,
  toggleCamera,
  cyclePip,
  toggleBlur,
  discard,
  setInkTool,
  setInkColor,
  clearInk,
  closeInkMode,
  toggleAnnotateDock,
  toggleCues,
  spawnRipple,
  spawnBadge,
  trimWebmBlob,
  openTrimReview,
  getTrimRange,
  shouldSkipTrimUi,
  /** Inject a stroke in compositor space (e2e). */
  _addInkStroke(stroke) {
    state.inkStrokes.push(stroke);
    paintInkOverlay();
  },
  /** Force one compositor tick (e2e). */
  _paintNow() {
    if (!state.ctx || !state.canvas) return null;
    const screenEl = $("#screen-preview");
    const camEl = $("#cam-preview");
    const ctx = state.ctx;
    if (state.sharing && screenEl.videoWidth > 2) {
      ctx.fillStyle = "#0b0d12";
      ctx.fillRect(0, 0, OUT_W, OUT_H);
      drawContain(ctx, screenEl, OUT_W, OUT_H);
    } else {
      drawWaiting(ctx, OUT_W, OUT_H);
    }
    drawInkLayer(ctx);
    drawCuesLayer(ctx, OUT_W, OUT_H);
    if (opts.camera && state.camera && !state.camOff && camEl.readyState >= 2 && camEl.videoWidth) {
      drawPip(ctx, camEl, OUT_W, OUT_H);
    }
    return { w: state.canvas.width, h: state.canvas.height };
  },
  /** @internal e2e helpers */
  _sync() {
    syncToggleUi();
    flags();
    liveStatus();
  },
  _armMic() {
    opts.mic = true;
    const track = { enabled: true, kind: "audio", stop() {} };
    state.mic = { getAudioTracks: () => [track], getTracks: () => [track], _track: track };
    syncToggleUi();
    flags();
    return track;
  },
  _armCam() {
    opts.camera = true;
    const track = { enabled: true, kind: "video", stop() {} };
    state.camera = { getVideoTracks: () => [track], getTracks: () => [track], _track: track };
    state.camOff = false;
    syncToggleUi();
    flags();
    return track;
  },
};

if (params.get("autostart") === "1") {
  start().catch((err) => {
    state.starting = false;
    toast(err.message || String(err));
    $("#btn-start").hidden = false;
    $("#btn-start").disabled = false;
  });
}
