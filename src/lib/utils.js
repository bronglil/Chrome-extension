// ============================================================================
// SnapShot Studio — shared utilities (reusable across popup, content, offscreen
// and editor). Exposed as a plain global `SnapShotUtils` so it works in classic
// content-script injection AND as a <script> in extension pages without a build
// step. Keep this dependency-free.
// ============================================================================
(function (root) {
  "use strict";

  // --- Async timing --------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Rate-limit a function to at most once per `wait` ms (leading + trailing).
  function throttle(fn, wait) {
    let last = 0, timer = null, lastArgs = null;
    return function (...args) {
      const now = Date.now();
      const remaining = wait - (now - last);
      lastArgs = args;
      if (remaining <= 0) {
        clearTimeout(timer); timer = null; last = now;
        fn.apply(this, args);
      } else if (!timer) {
        timer = setTimeout(() => {
          last = Date.now(); timer = null;
          fn.apply(this, lastArgs);
        }, remaining);
      }
    };
  }

  // Coalesce rapid calls into one per animation frame (ideal for slider redraws).
  function rafDebounce(fn) {
    let scheduled = false, lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        fn.apply(this, lastArgs);
      });
    };
  }

  // --- Image / blob helpers ------------------------------------------------
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function clampRect(r, W, H) {
    const x = Math.max(0, Math.round(r.x));
    const y = Math.max(0, Math.round(r.y));
    return {
      x, y,
      width: Math.min(Math.round(r.width), W - x),
      height: Math.min(Math.round(r.height), H - y),
    };
  }

  // --- Device profiling (performance across all devices) -------------------
  // Adapts work to the machine: fewer cores / less memory / slow network ->
  // gentler capture pacing, capped resolution, single-threaded OCR.
  function deviceProfile() {
    const cores = navigator.hardwareConcurrency || 4;
    const memory = navigator.deviceMemory || 4; // GiB, coarse
    const conn = navigator.connection || {};
    const saveData = !!conn.saveData;
    const slowNet = /(^|-)2g$/.test(conn.effectiveType || "") || saveData;
    const lowPower = cores <= 2 || memory <= 2 || slowNet;

    return {
      cores,
      memory,
      lowPower,
      saveData,
      // Cap the pixel ratio used when rasterizing so 3x/4x displays don't blow
      // up memory on modest GPUs.
      maxPixelRatio: Math.min(window.devicePixelRatio || 1, lowPower ? 1 : 2),
      // Full-page scroll pacing. captureVisibleTab is ~2/sec; low-power / lazy
      // pages need extra settle time for images to load.
      sliceDelayMs: lowPower ? 450 : 280,
      settleMs: lowPower ? 260 : 180,
      // Hard cap on stitched canvas height (below the ~32767px browser limit).
      maxCanvasPx: lowPower ? 16000 : 32000,
      // OCR worker count.
      ocrWorkers: Math.max(1, Math.min(lowPower ? 1 : 2, cores - 1)),
    };
  }

  const CAPTURE_DB = "snapshot-captures";
  const CAPTURE_STORE = "shots";

  function openCaptureDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CAPTURE_DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(CAPTURE_STORE)) {
          req.result.createObjectStore(CAPTURE_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function putCapture(id, value) {
    const db = await openCaptureDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_STORE, "readwrite");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.objectStore(CAPTURE_STORE).put(value, id);
    });
  }

  async function getCapture(id) {
    const db = await openCaptureDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_STORE, "readonly");
      const req = tx.objectStore(CAPTURE_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteCapture(id) {
    const db = await openCaptureDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_STORE, "readwrite");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.objectStore(CAPTURE_STORE).delete(id);
    });
  }

  async function pruneCaptures(keepId) {
    const db = await openCaptureDb();
    const keys = await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_STORE, "readonly");
      const req = tx.objectStore(CAPTURE_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    const drop = keys.filter((k) => k !== keepId).slice(0, Math.max(0, keys.length - 3));
    if (!drop.length) return;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(CAPTURE_STORE, "readwrite");
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      drop.forEach((k) => tx.objectStore(CAPTURE_STORE).delete(k));
    });
  }

  root.SnapShotUtils = {
    sleep, throttle, rafDebounce, loadImage, blobToDataUrl, clampRect, deviceProfile,
    putCapture, getCapture, deleteCapture, pruneCaptures,
  };
})(typeof self !== "undefined" ? self : window);
