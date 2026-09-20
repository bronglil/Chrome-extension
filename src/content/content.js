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
  const CONTENT_API = 4;
  if (window.__snapshotStudioApi >= CONTENT_API) return;
  window.__snapshotStudioApi = CONTENT_API;
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
        sendResponse({ ok: true, api: CONTENT_API });
        return false;
      case "START_AREA_SELECT":
        startAreaSelect(msg).then(sendResponse);
        return true;
      case "START_COPY_TEXT":
        startCopyText(msg).then(sendResponse);
        return true;
      case "COPY_TEXT_CAPTURED":
        sendResponse(revealCopySelection());
        return false;
      case "FILL_COPY_TEXT":
        sendResponse(fillLiveCopy(msg));
        return false;
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
  function startAreaSelect(msg = {}) {
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
      hint.textContent = msg.hint || "Drag to select · Esc to cancel";

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

  function rectsOverlap(a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  }

  function textInCssRect(box) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.closest("script,style,noscript,textarea,.snapshot-overlay,.snapshot-selection,.snapshot-copybar,.snapshot-hint,.snapshot-dims");
        if (tag) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const hits = [];
    let node;
    while ((node = walker.nextNode())) {
      const range = document.createRange();
      try { range.selectNodeContents(node); } catch (_) { continue; }
      const r = range.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      if (!rectsOverlap(box, { x: r.left, y: r.top, w: r.width, h: r.height })) continue;
      hits.push({ y: r.top, x: r.left, text: node.nodeValue.replace(/\s+/g, " ").trim() });
    }
    hits.sort((a, b) => a.y - b.y || a.x - b.x);
    return hits.map((h) => h.text).filter(Boolean).join("\n");
  }

  let liveCopy = null;

  function fillLiveCopy(msg) {
    revealCopySelection();
    if (!liveCopy) return { ok: false };
    const t = String(msg.text || "").trim();
    liveCopy.area.value = t || msg.error || "No text found in this area.";
    liveCopy.copyBtn.disabled = !t;
    if (t) {
      navigator.clipboard.writeText(t).catch(() => {});
      chrome.runtime.sendMessage({ type: "CLIP_REMEMBER", text: t }).catch(() => {});
      liveCopy.copyBtn.textContent = "Copied";
      liveCopy.area.focus();
      liveCopy.area.select();
    }
    return { ok: true };
  }

  function revealCopySelection() {
    if (!liveCopy) return { ok: false };
    liveCopy.nodes.forEach((n) => {
      if (!n.isConnected) return;
      n.style.visibility = "visible";
    });
    if (liveCopy.overlay) {
      liveCopy.overlay.style.pointerEvents = "none";
      liveCopy.overlay.style.background = "transparent";
    }
    if (liveCopy.bar) liveCopy.bar.hidden = false;
    return { ok: true };
  }

  function startCopyText() {
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
      hint.textContent = "Drag a box around the text · Esc to cancel";

      const nodes = [overlay, sel, dims, hint];
      nodes.forEach((n) => document.documentElement.appendChild(n));

      let startX = 0, startY = 0, dragging = false, finished = false, settled = false;

      function cleanup() {
        liveCopy = null;
        nodes.forEach((n) => n.remove());
        document.removeEventListener("keydown", onKey, true);
        window.removeEventListener("mouseup", onUp, true);
      }
      function onKey(e) {
        if (e.key !== "Escape") return;
        e.preventDefault();
        const wasSettled = settled;
        cleanup();
        if (!wasSettled) resolve({ cancelled: true });
        finished = true;
        settled = true;
      }
      function onUp(e) {
        if (!dragging || finished) return;
        dragging = false;
        const rect = geom(e.clientX, e.clientY);
        if (rect.w < 8 || rect.h < 8) return;
        finished = true;
        armCapture(rect);
      }
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("mouseup", onUp, true);

      overlay.addEventListener("mousedown", (e) => {
        if (finished) return;
        e.preventDefault();
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

      function geom(curX, curY) {
        return {
          x: Math.min(startX, curX),
          y: Math.min(startY, curY),
          w: Math.abs(curX - startX),
          h: Math.abs(curY - startY),
        };
      }
      function update(curX, curY) {
        const { x, y, w, h } = geom(curX, curY);
        sel.style.left = x + "px";
        sel.style.top = y + "px";
        sel.style.width = w + "px";
        sel.style.height = h + "px";
        dims.textContent = `${Math.round(w)} × ${Math.round(h)}`;
        dims.style.left = x + "px";
        dims.style.top = Math.max(0, y - 24) + "px";
      }

      function showCopyBar(rect) {
        const bar = document.createElement("div");
        bar.className = "snapshot-copybar";
        const area = document.createElement("textarea");
        area.className = "snapshot-copybar__text";
        area.value = "Reading text…";
        const acts = document.createElement("div");
        acts.className = "snapshot-copybar__acts";
        const copyBtn = document.createElement("button");
        copyBtn.type = "button";
        copyBtn.className = "snapshot-copybar__copy";
        copyBtn.textContent = "Copy text";
        copyBtn.disabled = true;
        const doneBtn = document.createElement("button");
        doneBtn.type = "button";
        doneBtn.className = "snapshot-copybar__done";
        doneBtn.textContent = "Done";
        acts.append(copyBtn, doneBtn);
        bar.append(area, acts);
        document.documentElement.appendChild(bar);
        nodes.push(bar);

        const top = rect.y + rect.h + 10 + 160 > window.innerHeight
          ? Math.max(8, rect.y - 168)
          : rect.y + rect.h + 8;
        bar.style.left = Math.max(8, Math.min(rect.x, window.innerWidth - 360)) + "px";
        bar.style.top = top + "px";
        bar.hidden = true;

        copyBtn.addEventListener("click", async () => {
          const value = area.value;
          if (!value || value === "Reading text…") return;
          try { await navigator.clipboard.writeText(value); } catch (_) { /* keep panel */ }
          copyBtn.textContent = "Copied";
        });
        doneBtn.addEventListener("click", cleanup);
        return { bar, area, copyBtn };
      }

      async function armCapture(rect) {
        hint.remove();
        dims.remove();
        const panel = showCopyBar(rect);
        liveCopy = { ...panel, overlay, nodes: [overlay, sel, panel.bar] };
        // Hide the box so the screenshot (and OCR) sees the real page, like Shottr.
        [overlay, sel, panel.bar].forEach((n) => { n.style.visibility = "hidden"; });
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        settled = true;
        resolve({
          deviceRect: {
            x: Math.round(rect.x * dpr),
            y: Math.round(rect.y * dpr),
            width: Math.round(rect.w * dpr),
            height: Math.round(rect.h * dpr),
          },
          domText: textInCssRect(rect),
          needOcr: true,
        });
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
      if (el.closest && el.closest(".snapshot-progress, .snapshot-overlay, .snapshot-copybar, .snapshot-error, .snapshot-hint, .snapshot-selection, .snapshot-dims")) continue;
      if ((cs.position === "fixed" || cs.position === "sticky") &&
          cs.display !== "none" && el.offsetHeight > 0) {
        hidden.push([el, el.style.visibility]);
      }
    }
    return hidden;
  }

  function progressHud() {
    let el = document.querySelector(".snapshot-progress");
    if (el) return el;
    el = document.createElement("div");
    el.className = "snapshot-progress";
    el.innerHTML =
      '<div class="snapshot-progress__title">Capturing full page</div>' +
      '<div class="snapshot-progress__count"></div>' +
      '<div class="snapshot-progress__dots"></div>';
    document.documentElement.appendChild(el);
    return el;
  }

  function hideProgressHud() {
    const el = document.querySelector(".snapshot-progress");
    if (el) el.style.visibility = "hidden";
  }

  function showProgressHud(done, total) {
    const el = progressHud();
    el.style.visibility = "visible";
    const left = Math.max(0, total - done);
    el.querySelector(".snapshot-progress__count").textContent =
      done + " taken · " + left + " left · " + total + " screens";
    const host = el.querySelector(".snapshot-progress__dots");
    host.innerHTML = "";
    const shown = Math.min(total, 32);
    const filled = total ? Math.round((done / total) * shown) : 0;
    for (let i = 0; i < shown; i++) {
      const d = document.createElement("span");
      d.className = "snapshot-progress__dot" + (i < filled ? " is-on" : "");
      host.appendChild(d);
    }
  }

  function removeProgressHud() {
    document.querySelector(".snapshot-progress")?.remove();
  }

  async function captureFullPage() {
    const html = document.documentElement;
    const originalScrollY = window.scrollY;
    const originalScrollX = window.scrollX;
    const prevOverflow = html.style.overflow;
    const prevBehavior = html.style.scrollBehavior;

    html.style.overflow = "hidden";
    html.style.scrollBehavior = "auto";

    let fixedHidden = [];
    try {
      window.scrollTo(0, 0);
      await sleep(profile.settleMs);

      const m = pageMetrics();
      const scaleY = (imgH) => imgH / Math.max(1, m.viewH);
      const cappedCss = Math.min(m.totalHeight, Math.floor(MAX_CANVAS / m.dpr));
      const total = Math.max(1, Math.ceil(cappedCss / Math.max(1, m.viewH)));
      let taken = 0;
      showProgressHud(0, total);

      const takeSlice = async () => {
        hideProgressHud();
        await sleep(40);
        const res = await requestSlice();
        taken += 1;
        showProgressHud(taken, total);
        return res;
      };

      const firstRes = await takeSlice();
      if (firstRes?.error) throw new Error(firstRes.error);
      const first = await loadImage(firstRes.dataUrl);

      const canvas = document.createElement("canvas");
      canvas.width = first.width;
      canvas.height = Math.min(Math.round(cappedCss * scaleY(first.height)), MAX_CANVAS);
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(first, 0, 0);

      let y = m.viewH;
      while (y < cappedCss - 1) {
        window.scrollTo(0, y);
        await sleep(profile.sliceDelayMs);
        const actualY = window.scrollY;

        if (!fixedHidden.length && actualY > 0) {
          fixedHidden = collectFixed();
          fixedHidden.forEach(([el]) => (el.style.visibility = "hidden"));
          await sleep(60);
        }

        const res = await takeSlice();
        if (res?.error) throw new Error(res.error);
        const img = await loadImage(res.dataUrl);
        const destY = Math.round(actualY * scaleY(first.height));
        const remaining = canvas.height - destY;
        if (remaining <= 2) break;

        const atEnd = actualY + m.viewH >= cappedCss - 1;
        const srcY = atEnd ? Math.max(0, img.height - remaining) : 0;
        const drawH = Math.min(img.height - srcY, remaining);
        ctx.drawImage(img, 0, srcY, img.width, drawH, 0, destY, img.width, drawH);

        if (atEnd || actualY + 1 < y) break;
        y = actualY + m.viewH;
        await sleep(Math.max(220, profile.sliceDelayMs - 60));
      }

      return {
        dataUrl: canvas.toDataURL("image/png"),
        width: canvas.width,
        height: canvas.height,
        tiles: m.totalHeight > cappedCss ? 2 : 1,
      };
    } finally {
      removeProgressHud();
      fixedHidden.forEach(([el, vis]) => (el.style.visibility = vis));
      html.style.overflow = prevOverflow;
      html.style.scrollBehavior = prevBehavior;
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
