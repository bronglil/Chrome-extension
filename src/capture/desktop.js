const kind = new URLSearchParams(location.search).get("kind") || "screen";
const $ = (s) => document.querySelector(s);

$("#title").textContent = kind === "window" ? "Share a window" : "Share a screen";
$("#hint").textContent = kind === "window"
  ? "Pick one app window in Chrome’s list, then click Share."
  : "Pick a monitor in Chrome’s list, then click Share.";

async function grab() {
  const btn = $("#share");
  const status = $("#status");
  btn.disabled = true;
  status.textContent = "Waiting for Chrome’s share dialog…";
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: 15, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        displaySurface: kind === "window" ? "window" : "monitor",
      },
      audio: false,
      preferCurrentTab: false,
    });
    status.textContent = "Capturing…";
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    await new Promise((r) => {
      if (video.videoWidth) return r();
      video.addEventListener("loadedmetadata", r, { once: true });
    });
    await new Promise((r) => setTimeout(r, 80));
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d").drawImage(video, 0, 0);
    stream.getTracks().forEach((t) => t.stop());
    const dataUrl = canvas.toDataURL("image/png");
    await chrome.runtime.sendMessage({
      type: "DESKTOP_FRAME",
      dataUrl,
      kind: "desktop-" + kind,
    });
    window.close();
  } catch (err) {
    btn.disabled = false;
    const cancelled = /cancell|denied|abort|NotAllowed/i.test((err?.name || "") + (err?.message || ""));
    status.textContent = cancelled
      ? "Nothing was shared. Click the button to try again."
      : (err.message || String(err));
  }
}

$("#share").addEventListener("click", grab);
