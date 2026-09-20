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
