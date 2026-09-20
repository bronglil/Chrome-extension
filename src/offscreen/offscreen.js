// ============================================================================
// Offscreen document — the only place with DOM + media access in MV3.
// Handles single-frame desktop grabs and screen recording (MediaRecorder).
// Driven entirely by messages from the service worker (target: "offscreen").
// ============================================================================

const U = self.SnapShotUtils || {};
const blobToDataUrl = U.blobToDataUrl || ((blob) => new Promise((resolve, reject) => {
  const fr = new FileReader();
  fr.onload = () => resolve(fr.result);
  fr.onerror = reject;
  fr.readAsDataURL(blob);
}));

let recorder = null;
let recordedChunks = [];
let activeStream = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "offscreen") return false;

  (async () => {
    try {
      switch (msg.type) {
        case "GRAB_FRAME":
          sendResponse(await grabFrame(msg.streamId));
          break;
        case "START_RECORDING":
          sendResponse(await startRecording(msg));
          break;
        case "STOP_RECORDING":
          sendResponse(await stopRecording());
          break;
        case "OCR_CROP":
          sendResponse(await ocrCrop(msg.dataUrl, msg.rect));
          break;
        default:
          sendResponse({ error: "offscreen: unknown " + msg.type });
      }
    } catch (err) {
      console.error("[SnapShot offscreen]", err);
      sendResponse({ error: err.message || String(err) });
    }
  })();
  return true;
});

// Build a MediaStream from a desktopCapture stream id.
async function getDesktopStream(streamId, { video = true, systemAudio = false } = {}) {
  const constraints = {
    audio: systemAudio
      ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } }
      : false,
    video: video
      ? { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId } }
      : false,
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

// --- Single frame grab (full screen / active window) ------------------------
async function grabFrame(streamId) {
  const stream = await getDesktopStream(streamId, { video: true });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Wait for real dimensions.
    await new Promise((r) => {
      if (video.videoWidth) return r();
      video.addEventListener("loadedmetadata", r, { once: true });
    });
    // Small settle so the first frame isn't black.
    await new Promise((r) => setTimeout(r, 120));

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    const dataUrl = canvas.toDataURL("image/png");
    return { dataUrl, width: canvas.width, height: canvas.height };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}

// --- Screen recording -------------------------------------------------------
async function startRecording({ streamId, mic = false, systemAudio = false }) {
  if (recorder) return { error: "Already recording." };

  const display = await getDesktopStream(streamId, { video: true, systemAudio });
  const tracks = [...display.getVideoTracks()];
  const audioTracks = [...display.getAudioTracks()];

  if (mic) {
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioTracks.push(...micStream.getAudioTracks());
    } catch (e) {
      console.warn("[SnapShot] mic unavailable:", e);
    }
  }

  activeStream = new MediaStream([...tracks, ...audioTracks]);

  const mime = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ].find((t) => MediaRecorder.isTypeSupported(t)) || "video/webm";

  recordedChunks = [];
  recorder = new MediaRecorder(activeStream, { mimeType: mime });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size) recordedChunks.push(e.data);
  };
  recorder.onstop = finalizeRecording;

  // If the user stops sharing via Chrome's bar, end the recording.
  display.getVideoTracks()[0].addEventListener("ended", () => {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  });

  recorder.start(1000); // gather in 1s chunks
  return { ok: true };
}

async function stopRecording() {
  if (!recorder) return { error: "Not recording." };
  if (recorder.state !== "inactive") recorder.stop();
  return { ok: true };
}

async function finalizeRecording() {
  const blob = new Blob(recordedChunks, { type: "video/webm" });
  const dataUrl = await blobToDataUrl(blob);
  if (activeStream) activeStream.getTracks().forEach((t) => t.stop());
  recorder = null;
  activeStream = null;
  recordedChunks = [];
  chrome.runtime.sendMessage({ type: "RECORDING_DONE", dataUrl });
}

// --- Area OCR (crop a capture, then Tesseract) ------------------------------
/* global Tesseract */
let ocrWorker = null;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function preprocessForOcr(src) {
  const MIN_DIM = 1600;
  const scale = Math.min(3, Math.max(1, MIN_DIM / Math.max(src.width, src.height)));
  const w = Math.round(src.width * scale);
  const h = Math.round(src.height * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8Array(w * h);
  const hist = new Array(256).fill(0);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    gray[p] = g;
    hist[g]++;
  }
  const total = w * h;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thresh = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; thresh = t; }
  }
  let dark = 0;
  for (let p = 0; p < total; p++) if (gray[p] < thresh) dark++;
  const invert = dark > total * 0.55;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let on = gray[p] < thresh;
    if (invert) on = !on;
    const v = on ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const base = chrome.runtime.getURL("vendor/tesseract/");
  ocrWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: base + "worker.min.js",
    corePath: chrome.runtime.getURL("vendor/tesseract/"),
    langPath: base + "lang",
    gzip: true,
    workerBlobURL: false,
  });
  await ocrWorker.setParameters({
    tessedit_pageseg_mode: "6",
    preserve_interword_spaces: "1",
    tessedit_do_invert: "0",
  });
  return ocrWorker;
}

async function ocrCrop(dataUrl, rect) {
  if (!dataUrl || !rect) return { error: "Nothing to read." };
  const img = await loadImage(dataUrl);
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const w = Math.min(img.width - x, Math.round(rect.width));
  const h = Math.min(img.height - y, Math.round(rect.height));
  if (w < 4 || h < 4) return { error: "Selection is too small." };
  const crop = document.createElement("canvas");
  crop.width = w;
  crop.height = h;
  crop.getContext("2d").drawImage(img, x, y, w, h, 0, 0, w, h);
  const worker = await getOcrWorker();
  const { data } = await worker.recognize(preprocessForOcr(crop));
  const text = (data.text || "").trim();
  return { text };
}
