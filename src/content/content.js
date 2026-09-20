// ============================================================================
// Content script — runs in the page. Two jobs:
//   1. Area selection: draw a rectangle overlay, return the chosen rect
//      (scaled to device pixels so it maps onto the captured image).
//   2. Full-page capture: scroll one viewport at a time, ask the service
//      worker to capture each slice, then stitch onto one tall canvas.
//
// Injected on demand by the service worker (executeScript). Guards against
// double-injection with a global flag.
// ============================================================================

(() => {
  if (window.__snapshotStudioInjected) {
    // Already present: just (re)register the listener below is idempotent.
  }
  window.__snapshotStudioInjected = true;

  // Shared helpers (injected before this script). Fall back gracefully.
  const U = window.SnapShotUtils || {};
  const profile = U.deviceProfile ? U.deviceProfile() : {
    maxCanvasPx: 32000, sliceDelayMs: 280, settleMs: 180,
  };
  const MAX_CANVAS = profile.maxCanvasPx; // device-adaptive canvas height cap

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case "PING":
        sendResponse({ ok: true });
        return false;
      case "START_AREA_SELECT":
        startAreaSelect().then(sendResponse);
        return true;
      case "START_FULL_PAGE":
        captureFullPage().then(sendResponse).catch((e) =>
          sendResponse({ error: e.message || String(e) })
        );
        return true;
      default:
        return false;
    }
  });

  // -------------------------------------------------------------------------
  // Area selection
  // -------------------------------------------------------------------------
  function startAreaSelect() {
    return new Promise((resolve) => {
      const dpr = window.devicePixelRatio || 1;
      const overlay = document.createElement("div");
      overlay.className = "snapshot-overlay";
      const sel = document.createElement("div");
      sel.className = "snapshot-selection";
      sel.style.display = "none";
      const dims = document.createElement("div");
      dims.className = "snapshot-dims";
      dims.style.display = "none";
      const hint = document.createElement("div");
      hint.className = "snapshot-hint";
      hint.textContent = "Drag to select · Esc to cancel";

      const nodes = [overlay, sel, dims, hint];
      nodes.forEach((n) => document.documentElement.appendChild(n));

      let startX = 0, startY = 0, dragging = false;

      function cleanup() {
        nodes.forEach((n) => n.remove());
        document.removeEventListener("keydown", onKey, true);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          cleanup();
          resolve(null);
        }
      }
      document.addEventListener("keydown", onKey, true);

      overlay.addEventListener("mousedown", (e) => {
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        sel.style.display = "block";
        dims.style.display = "block";
        update(e.clientX, e.clientY);
      });
      overlay.addEventListener("mousemove", (e) => {
        if (dragging) update(e.clientX, e.clientY);
      });
      window.addEventListener("mouseup", (e) => {
        if (!dragging) return;
        dragging = false;
        const rect = geom(e.clientX, e.clientY);
        cleanup();
        if (rect.w < 5 || rect.h < 5) return resolve(null);
        // Scale viewport coords -> captured-image (device) pixels.
        resolve({
          x: Math.round(rect.x * dpr),
          y: Math.round(rect.y * dpr),
          width: Math.round(rect.w * dpr),
          height: Math.round(rect.h * dpr),
        });
      });

      function geom(curX, curY) {
        const x = Math.min(startX, curX);
        const y = Math.min(startY, curY);
        const w = Math.abs(curX - startX);
        const h = Math.abs(curY - startY);
        return { x, y, w, h };
      }
      function update(curX, curY) {
        const { x, y, w, h } = geom(curX, curY);
        sel.style.left = x + "px";
        sel.style.top = y + "px";
        sel.style.width = w + "px";
        sel.style.height = h + "px";
        dims.textContent = `${w} × ${h}`;
        dims.style.left = x + "px";
        dims.style.top = Math.max(0, y - 24) + "px";
      }
    });
  }

  // -------------------------------------------------------------------------
  // Full-page scroll-and-stitch
  // -------------------------------------------------------------------------
  const sleep = U.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  function pageMetrics() {
    const doc = document.documentElement;
    const body = document.body;
    const totalHeight = Math.max(
      doc.scrollHeight, body ? body.scrollHeight : 0,
      doc.offsetHeight, body ? body.offsetHeight : 0,
      doc.clientHeight
    );
    const totalWidth = Math.max(
      doc.scrollWidth, body ? body.scrollWidth : 0, doc.clientWidth
    );
    return {
      totalHeight,
      totalWidth,
      viewH: window.innerHeight,
      viewW: window.innerWidth,
      dpr: window.devicePixelRatio || 1,
    };
  }

  // Hide fixed/sticky elements (so headers don't duplicate on every slice).
  function collectFixed() {
    const hidden = [];
    const els = document.querySelectorAll("*");
    for (const el of els) {
      const cs = getComputedStyle(el);
      if ((cs.position === "fixed" || cs.position === "sticky") &&
          cs.display !== "none" && el.offsetHeight > 0) {
        hidden.push([el, el.style.visibility]);
      }
    }
    return hidden;
  }

  async function captureFullPage() {
    const m = pageMetrics();
    const originalScrollY = window.scrollY;
    const originalScrollX = window.scrollX;
    const originalOverflow = document.documentElement.style.overflow;

    // Cap total height to the canvas limit; tile if the page is taller.
    const cappedHeight = Math.min(m.totalHeight, Math.floor(MAX_CANVAS / m.dpr));

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(m.totalWidth * m.dpr);
    canvas.height = Math.round(cappedHeight * m.dpr);
    const ctx = canvas.getContext("2d");

    let fixedHidden = [];
    try {
      window.scrollTo(0, 0);
      await sleep(profile.settleMs); // let lazy content settle at top

      let y = 0;
      let first = true;
      while (y < cappedHeight) {
        window.scrollTo(0, y);
        await sleep(profile.sliceDelayMs); // wait for scroll + lazy images

        // After the first slice, hide fixed/sticky elements to avoid repeats.
        if (first) {
          first = false;
        } else if (fixedHidden.length === 0) {
          fixedHidden = collectFixed();
          fixedHidden.forEach(([el]) => (el.style.visibility = "hidden"));
          await sleep(60);
        }

        // Ask the service worker to capture the visible tab (rate-limited).
        const res = await requestSlice();
        if (res?.error) throw new Error(res.error);
        const img = await loadImage(res.dataUrl);

        const sliceTopDevice = Math.round(y * m.dpr);
        // On the last slice the scroll can't advance a full viewport; the
        // captured image still shows the bottom viewport, so draw the portion
        // that belongs below sliceTop.
        const remaining = canvas.height - sliceTopDevice;
        const drawH = Math.min(img.height, remaining);
        const srcY = img.height - drawH; // bottom-align on the final short slice
        const alignedTop = y + m.viewH <= cappedHeight ? sliceTopDevice
          : canvas.height - drawH;

        if (y + m.viewH <= cappedHeight) {
          ctx.drawImage(img, 0, 0, img.width, drawH, 0, sliceTopDevice, img.width, drawH);
        } else {
          ctx.drawImage(img, 0, srcY, img.width, drawH, 0, alignedTop, img.width, drawH);
        }

        if (y + m.viewH >= cappedHeight) break;
        y += m.viewH;

        // Respect captureVisibleTab's ~2/sec rate limit (device-adaptive).
        await sleep(Math.max(220, profile.sliceDelayMs - 60));
      }

      const dataUrl = canvas.toDataURL("image/png");
      return {
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        tiles: m.totalHeight > cappedHeight ? 2 : 1,
      };
    } finally {
      fixedHidden.forEach(([el, vis]) => (el.style.visibility = vis));
      document.documentElement.style.overflow = originalOverflow;
      window.scrollTo(originalScrollX, originalScrollY);
    }
  }

  function requestSlice() {
    return chrome.runtime.sendMessage({ type: "CAPTURE_SLICE" });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
})();
