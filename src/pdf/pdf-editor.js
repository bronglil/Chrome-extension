// ============================================================================
// SnapShot Studio — PDF Editor
// Open a PDF, place a signature (drawn / typed / uploaded) on a specific spot,
// add text or freehand marks, then export a real PDF with the ORIGINAL pages
// preserved (annotations are overlaid via pdf-lib, not a flattened re-render).
//
// Libraries: pdf.js (render pages), pdf-lib (embed overlays & save), Konva
// (interactive overlay canvas).
// ============================================================================

/* global pdfjsLib, PDFLib, Konva */

const $ = (s) => document.querySelector(s);
const U = window.SnapShotUtils;

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.js");

const DEVICE = U.deviceProfile();

// Fit the page to the editor width, then rasterize at device pixel ratio so
// type stays sharp on retina without blowing memory on low-power machines.
function pageDisplayScale(page) {
  const wrap = $("#pe-stage-wrap");
  const avail = Math.max(360, (wrap?.clientWidth || 720) - 56);
  const base = page.getViewport({ scale: 1 });
  return avail / base.width;
}
function rasterDpr() {
  return Math.min(DEVICE.maxPixelRatio || 2, window.devicePixelRatio || 1, 2.5);
}

const state = {
  pdfBytes: null,      // original file bytes (Uint8Array) for pdf-lib
  pdfDoc: null,        // pdf.js document
  numPages: 0,
  pageNum: 1,
  fileName: "document.pdf",
  stage: null,
  baseLayer: null,     // rendered PDF page image
  overlayLayer: null,  // annotations (signatures/text/draw)
  transformer: null,
  tool: "select",
  drawing: null,
  // Per-page overlay JSON + the pixel viewport used when rendered.
  pageOverlays: {},    // { [pageNum]: konvaJSON }
  pageSizes: {},       // { [pageNum]: {w,h} } in rendered pixels
  acknowledge: false,  // stamp "AK" at the bottom of every page
  ackLayer: null,      // on-screen AK badge (redrawn per page; not serialized)
  pageCanvas: null,    // the rendered pixels of the current page (for occupancy checks)
  views: {},           // { [pageNum]: mounted Konva view } — only nearby pages
  slots: {},           // { [pageNum]: { el, stageEl, w, h } } — lightweight placeholders
};

// Is a corner region of a rendered page canvas already occupied by content?
// Samples the bottom band and returns the ink ratio (0..1) of non-white pixels.
function regionInkRatio(canvas, side) {
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const bandH = Math.max(24, Math.round(canvas.height * 0.09));
    const boxW = Math.round(canvas.width * 0.34);
    const x = side === "right" ? canvas.width - boxW : 0;
    const y = canvas.height - bandH;
    const { data } = ctx.getImageData(x, y, boxW, bandH);
    let ink = 0, total = 0;
    for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
      total++;
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      if (a > 20 && (r < 235 || g < 235 || b < 235)) ink++;
    }
    return total ? ink / total : 0;
  } catch (_) { return 0; }
}

// Pick the side for the AK so it does not overwrite existing content:
// prefer right; if right is busy use left; if both busy, the emptier one.
function chooseAckSide(canvas) {
  const OCCUPIED = 0.015; // >1.5% of sampled pixels have ink ⇒ occupied
  const right = regionInkRatio(canvas, "right");
  const left = regionInkRatio(canvas, "left");
  if (right < OCCUPIED) return "right";
  if (left < OCCUPIED) return "left";
  return right <= left ? "right" : "left";
}

// ---- UI helpers ------------------------------------------------------------
function toast(msg, ms = 2200) {
  const t = $("#pe-toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function progress(label, pct) {
  const p = $("#pe-progress"); p.hidden = false;
  $("#pe-progress-label").textContent = label;
  $("#pe-progress-bar").style.width = Math.round(pct * 100) + "%";
}
function hideProgress() { $("#pe-progress").hidden = true; }

const prop = {
  color: () => $("#pe-color").value,
  highlight: () => $("#pe-highlight")?.value || "#ffd43b",
  stroke: () => +$("#pe-stroke").value,
  font: () => +$("#pe-font").value,
};

// ---------------------------------------------------------------------------
// Open a PDF
// ---------------------------------------------------------------------------
async function openPdf(arrayBuffer, name) {
  state.pdfBytes = new Uint8Array(arrayBuffer);
  state.fileName = name || "document.pdf";
  // pdf.js consumes the buffer, so hand it a copy and keep our own bytes.
  state.pdfDoc = await pdfjsLib.getDocument({
    data: state.pdfBytes.slice(),
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;
  state.numPages = state.pdfDoc.numPages;
  state.pageNum = 1;
  state.pageOverlays = {};
  state.pageSizes = {};
  const chip = $("#pe-file");
  chip.textContent = state.fileName;
  chip.hidden = false;
  $("#pe-empty").hidden = true;
  $("#pe-save").disabled = false;
  await renderAllPages();
  updatePager();
}

$("#pe-open").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  openPdf(await file.arrayBuffer(), file.name).catch((err) => toast("Open failed: " + err.message));
});

// Drag & drop a PDF.
const wrap = $("#pe-stage-wrap");
wrap.addEventListener("dragover", (e) => e.preventDefault());
wrap.addEventListener("drop", async (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type === "application/pdf") {
    openPdf(await file.arrayBuffer(), file.name).catch((err) => toast("Open failed: " + err.message));
  }
});

// ---------------------------------------------------------------------------
// Continuous scroll: placeholders for every page, rasterize only nearby ones
// ---------------------------------------------------------------------------
function clearViews() {
  Object.keys(state.views).forEach((n) => unmountPage(+n));
  state.views = {};
  state.slots = {};
  state.stage = null;
  state.baseLayer = null;
  state.overlayLayer = null;
  state.transformer = null;
  state.ackLayer = null;
  state.pageCanvas = null;
  const host = $("#pe-pages");
  if (host) host.innerHTML = "";
}

function unmountPage(num) {
  const view = state.views[num];
  if (!view) return;
  saveOverlay(num);
  try { view.stage.destroy(); } catch (_) { /* already gone */ }
  if (view.pageCanvas) {
    view.pageCanvas.width = 0;
    view.pageCanvas.height = 0;
  }
  if (state.stage === view.stage) {
    state.stage = null;
    state.baseLayer = null;
    state.overlayLayer = null;
    state.transformer = null;
    state.ackLayer = null;
    state.pageCanvas = null;
  }
  delete state.views[num];
}

function activatePage(num, { scroll = false } = {}) {
  const view = state.views[num];
  if (!view) return;
  if (state.pageNum !== num && state.transformer) {
    try { state.transformer.nodes([]); } catch (_) { /* ignore */ }
  }
  state.pageNum = num;
  state.stage = view.stage;
  state.baseLayer = view.baseLayer;
  state.overlayLayer = view.overlayLayer;
  state.transformer = view.transformer;
  state.ackLayer = view.ackLayer;
  state.pageCanvas = view.pageCanvas;
  updatePager();
  if (scroll) {
    view.el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function mountPage(num, container) {
  const page = await state.pdfDoc.getPage(num);
  const dpr = rasterDpr();
  const fit = pageDisplayScale(page);
  const viewport = page.getViewport({ scale: fit * dpr });
  const displayW = Math.max(1, Math.round(viewport.width / dpr));
  const displayH = Math.max(1, Math.round(viewport.height / dpr));

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  await page.render({ canvasContext: ctx, viewport, intent: "display" }).promise;

  const prev = state.pageSizes[num];
  if (prev && prev.w && Math.abs(prev.w - displayW) > 2) {
    scaleSavedOverlay(num, displayW / prev.w);
  }
  state.pageSizes[num] = { w: displayW, h: displayH, dpr };

  Konva.pixelRatio = dpr;
  const stage = new Konva.Stage({ container, width: displayW, height: displayH });
  const baseLayer = new Konva.Layer({ listening: false });
  const overlayLayer = new Konva.Layer();
  const ackLayer = new Konva.Layer({ listening: false });
  stage.add(baseLayer, overlayLayer, ackLayer);
  baseLayer.add(new Konva.Image({ image: canvas, width: displayW, height: displayH }));
  const transformer = new Konva.Transformer({ rotateEnabled: true, ignoreStroke: true });
  overlayLayer.add(transformer);
  baseLayer.draw();
  const content = stage.container().querySelector(".konvajs-content");
  if (content) {
    content.style.width = displayW + "px";
    content.style.height = displayH + "px";
  }
  stage.container().querySelectorAll("canvas").forEach((c) => {
    c.style.width = displayW + "px";
    c.style.height = displayH + "px";
  });

  const view = {
    num, el: container.closest(".pe-page"),
    stage, baseLayer, overlayLayer, ackLayer, transformer, pageCanvas: canvas,
  };
  state.views[num] = view;
  loadOverlay(num);
  bindStage(view);
  overlayLayer.draw();
  drawAckOn(view);
}

async function renderAllPages() {
  saveAllOverlays();
  clearViews();
  const host = $("#pe-pages");
  const dpr = rasterDpr();
  for (let n = 1; n <= state.numPages; n++) {
    const page = await state.pdfDoc.getPage(n);
    const fit = pageDisplayScale(page);
    const vp = page.getViewport({ scale: fit });
    const displayW = Math.max(1, Math.round(vp.width));
    const displayH = Math.max(1, Math.round(vp.height));
    const prev = state.pageSizes[n];
    if (prev && prev.w && Math.abs(prev.w - displayW) > 2) {
      scaleSavedOverlay(n, displayW / prev.w);
    }
    state.pageSizes[n] = { w: displayW, h: displayH, dpr };

    const card = document.createElement("section");
    card.className = "pe-page";
    card.dataset.page = String(n);
    const stageEl = document.createElement("div");
    stageEl.className = "pe-stage";
    if (n === 1) stageEl.id = "pe-stage";
    stageEl.style.width = displayW + "px";
    stageEl.style.height = displayH + "px";
    card.appendChild(stageEl);
    host.appendChild(card);
    state.slots[n] = { el: card, stageEl, w: displayW, h: displayH };
  }
  watchScroll();
  await syncLivePages();
  activatePage(state.pageNum || 1);
  drawAck();
}

function goToPage(num) {
  const slot = state.slots[num];
  if (slot?.el) slot.el.scrollIntoView({ behavior: "auto", block: "start" });
  ensureMounted(num).then(() => {
    activatePage(num);
    scheduleLiveSync();
  });
}

// Draw (or clear) the on-screen "AK" badge at the bottom-centre of the page.
function drawAckOn(view) {
  if (!view?.ackLayer) return;
  view.ackLayer.destroyChildren();
  if (state.acknowledge && view.stage) {
    const W = view.stage.width();
    const H = view.stage.height();
    const text = new Konva.Text({
      text: "AK", fontSize: 30, fontStyle: "italic bold",
      fontFamily: '"Segoe Script","Snell Roundhand","Brush Script MT",cursive',
      fill: "#4f46e5",
    });
    const tw = text.width();
    const side = view.pageCanvas ? chooseAckSide(view.pageCanvas) : "right";
    const x = side === "right" ? W - tw - 40 : 40;
    const y = H - 52;
    text.position({ x, y });
    const underline = new Konva.Line({
      points: [x - 4, y + 34, x + tw + 4, y + 34], stroke: "#4f46e5", strokeWidth: 1.5, lineCap: "round",
    });
    view.ackLayer.add(underline, text);
  }
  view.ackLayer.draw();
}

function drawAck() {
  Object.values(state.views).forEach(drawAckOn);
}

// Toggle the acknowledgement.
document.addEventListener("DOMContentLoaded", () => {}); // noop guard for order
function syncAckButtons() {
  $("#pe-ack")?.classList.toggle("is-active", state.acknowledge);
  $("#pe-ack-tool")?.classList.toggle("is-on", state.acknowledge);
}

function toggleAck() {
  if (!state.pdfDoc) { toast("Open a PDF first"); return; }
  state.acknowledge = !state.acknowledge;
  syncAckButtons();
  drawAck();
  toast(state.acknowledge ? "AK will be stamped on every page" : "Acknowledgement removed");
}

function wireAck() {
  $("#pe-ack")?.addEventListener("click", toggleAck);
}
wireAck();

function scaleSavedOverlay(num, factor) {
  const json = state.pageOverlays[num];
  if (!json || !factor || factor === 1) return;
  try {
    const parsed = JSON.parse(json);
    const walk = (node) => {
      if (!node || !node.attrs) return;
      ["x", "y", "width", "height", "fontSize", "strokeWidth", "radiusX", "radiusY"].forEach((k) => {
        if (typeof node.attrs[k] === "number") node.attrs[k] *= factor;
      });
      if (Array.isArray(node.attrs.points)) {
        node.attrs.points = node.attrs.points.map((n) => n * factor);
      }
      (node.children || []).forEach(walk);
    };
    (parsed.children || []).forEach(walk);
    state.pageOverlays[num] = JSON.stringify(parsed);
  } catch (_) { /* keep previous overlay if scale fails */ }
}

function saveOverlay(num) {
  const view = state.views[num];
  const layer = view?.overlayLayer || (num === state.pageNum ? state.overlayLayer : null);
  const transformer = view?.transformer || state.transformer;
  if (!layer) return;
  if (transformer) transformer.nodes([]);
  const clone = layer.clone();
  clone.find("Transformer").forEach((t) => t.destroy());
  state.pageOverlays[num] = clone.toJSON();
}

function saveAllOverlays() {
  Object.keys(state.views).forEach((n) => saveOverlay(+n));
}

function loadOverlay(num) {
  const view = state.views[num];
  const layer = view?.overlayLayer;
  if (!layer) return;
  const json = state.pageOverlays[num];
  if (!json) return;
  const parsed = JSON.parse(json);
  (parsed.children || []).forEach((childCfg) => {
    const node = Konva.Node.create(JSON.stringify(childCfg));
    reviveImages(node, layer);
    node.draggable(true);
    layer.add(node);
  });
}

// Konva.Image loses its bitmap through JSON; we stash the data URL in attrs.
function reviveImages(node, layer) {
  const imgs = node.className === "Image" ? [node] : (node.find ? node.find("Image") : []);
  imgs.forEach((kimg) => {
    const src = kimg.getAttr("srcDataUrl");
    if (src) {
      const im = new Image();
      im.onload = () => { kimg.image(im); (layer || state.overlayLayer)?.draw(); };
      im.src = src;
    }
  });
}

// ---------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------
function updatePager() {
  const info = $("#pe-pageinfo");
  if (info) info.textContent = state.numPages ? `${state.pageNum} / ${state.numPages}` : "— / —";
}

function pagesToKeepLive() {
  const want = new Set();
  const root = $("#pe-scroll");
  if (!root) {
    want.add(state.pageNum || 1);
    return want;
  }
  const rr = root.getBoundingClientRect();
  const pad = 160;
  for (let n = 1; n <= state.numPages; n++) {
    const el = state.slots[n]?.el;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom > rr.top - pad && r.top < rr.bottom + pad) {
      want.add(n);
      if (n > 1) want.add(n - 1);
      if (n < state.numPages) want.add(n + 1);
    }
  }
  want.add(state.pageNum || 1);
  if (!want.size) want.add(1);
  return want;
}

function nearestVisiblePage() {
  const root = $("#pe-scroll");
  if (!root) return state.pageNum;
  const box = root.getBoundingClientRect();
  const top = box.top + 20;
  let best = 0;
  let bestDist = Infinity;
  for (let n = 1; n <= state.numPages; n++) {
    const el = state.slots[n]?.el;
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom < box.top || r.top > box.bottom) continue;
    const dist = Math.abs(r.top - top);
    if (dist < bestDist) {
      bestDist = dist;
      best = n;
    }
  }
  return best || state.pageNum;
}

const mounting = new Map();
async function ensureMounted(num) {
  if (state.views[num] || !state.slots[num]) return;
  if (mounting.has(num)) return mounting.get(num);
  const job = mountPage(num, state.slots[num].stageEl).finally(() => mounting.delete(num));
  mounting.set(num, job);
  await job;
}

let liveSyncing = false;
let liveAgain = false;
let liveTimer = 0;
function scheduleLiveSync() {
  if (liveTimer) return;
  liveTimer = requestAnimationFrame(() => {
    liveTimer = 0;
    syncLivePages().catch(() => {});
  });
}

async function syncLivePages() {
  if (liveSyncing) {
    liveAgain = true;
    return;
  }
  liveSyncing = true;
  try {
    do {
      liveAgain = false;
      const want = pagesToKeepLive();
      Object.keys(state.views).forEach((k) => {
        const n = +k;
        if (!want.has(n)) unmountPage(n);
      });
      for (const n of [...want].sort((a, b) => a - b)) {
        await ensureMounted(n);
      }
      const nearest = nearestVisiblePage();
      if (nearest) activatePage(nearest);
    } while (liveAgain);
  } finally {
    liveSyncing = false;
  }
}

function onScrollLive() {
  scheduleLiveSync();
}

function watchScroll() {
  const root = $("#pe-scroll");
  if (!root) return;
  root.removeEventListener("scroll", onScrollLive);
  root.addEventListener("scroll", onScrollLive, { passive: true });
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (!state.pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderAllPages().catch(() => {});
  }, 280);
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
function setToolCursors() {
  const cursor = state.tool === "select" ? "default" : "crosshair";
  Object.values(state.views).forEach((v) => {
    if (v.stage) v.stage.container().style.cursor = cursor;
  });
}

document.querySelectorAll(".rail__tool[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const next = btn.dataset.tool;
    if (next === "ack") {
      toggleAck();
      return;
    }

    const selected = (state.transformer?.nodes() || []).slice();
    const selectedText = selected.find((n) => n.className === "Text");

    // Select text, then click Highlight → put a highlight behind that text.
    if (next === "highlight" && selectedText) {
      highlightSelectedText(selectedText);
      document.querySelectorAll(".rail__tool[data-tool]").forEach((b) => b.classList.remove("is-active"));
      document.querySelector('.rail__tool[data-tool="select"]')?.classList.add("is-active");
      state.tool = "select";
      state.transformer.nodes([selectedText]);
      setToolCursors();
      toast("Highlight added — pick a highlighter color to change it.");
      return;
    }

    document.querySelectorAll(".rail__tool[data-tool]").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.tool = next;
    if (state.transformer && next !== "select") state.transformer.nodes([]);
    setToolCursors();
    if (state.tool === "sign") {
      if (!state.stage) { toast("Open a PDF first"); return; }
      openSigModal();
    }
    if (state.tool === "date") stampDate();
  });
});

$("#pe-delete").addEventListener("click", deleteSelected);
document.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && state.transformer?.nodes().length) {
    if (["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    e.preventDefault(); deleteSelected();
  }
});
function deleteSelected() {
  if (!state.transformer || !state.overlayLayer) return;
  const nodes = state.transformer.nodes() || [];
  if (!nodes.length) return;
  nodes.forEach((n) => {
    if (n.className === "Text" && n.getAttr("markId")) {
      findLinkedHighlight(n)?.destroy();
    }
    n.destroy();
  });
  state.transformer.nodes([]);
  state.overlayLayer.draw();
}

function findTextNode(target) {
  let n = target;
  while (n && n !== state.stage) {
    if (n.className === "Text") return n;
    n = typeof n.getParent === "function" ? n.getParent() : null;
  }
  return (state.transformer?.nodes() || []).find((x) => x.className === "Text") || null;
}

function showTextPanel(node) {
  const panel = $("#pe-text-panel");
  const box = $("#pe-text-value");
  if (!panel || !box) return;
  if (!node) { panel.hidden = true; return; }
  panel.hidden = false;
  if (box !== document.activeElement) box.value = node.text();
}

function bindStage(view) {
  const stage = view?.stage || state.stage;
  if (!stage) return;
  stage.off(".pdfed");
  stage.on("mousedown.pdfed touchstart.pdfed", (e) => {
    if (view) activatePage(view.num);
    if (state.tool === "select") {
      if (e.target === stage || e.target.getLayer() === state.baseLayer) {
        state.transformer.nodes([]);
        showTextPanel(null);
      }
      return;
    }
    if (state.tool === "pen" || state.tool === "highlight") startDraw(e);
  });
  stage.on("mousemove.pdfed touchmove.pdfed", (e) => { if (state.drawing) extendDraw(e); });
  stage.on("mouseup.pdfed touchend.pdfed", endDraw);

  stage.on("click.pdfed tap.pdfed", (e) => {
    const existing = findTextNode(e.target);
    if (state.tool === "text") {
      if (existing) {
        selectTool("select");
        state.transformer.nodes([existing]);
        showTextPanel(existing);
        editText(existing);
        return;
      }
      addTextAt(pointer(e));
      return;
    }
    if (state.tool !== "select") return;
    if (e.target.getLayer() === state.baseLayer || e.target === stage) return;
    if (e.target.getParent()?.className === "Transformer") {
      showTextPanel(findTextNode(e.target));
      return;
    }
    const target = e.target.getParent()?.hasName && e.target.getParent().hasName("sig") ? e.target.getParent() : e.target;
    state.transformer.nodes([target]);
    showTextPanel(target.className === "Text" ? target : null);
    syncInspector(target);
  });

  stage.on("dblclick.pdfed dbltap.pdfed", (e) => {
    const text = findTextNode(e.target);
    if (text) editText(text);
  });
}

function pointer(evt, stage = state.stage) {
  if (!stage) return null;
  const el = stage.container().querySelector("canvas") || stage.container();
  const box = el.getBoundingClientRect();
  if (!box.width || !box.height) return stage.getPointerPosition();
  const native = evt && evt.evt ? evt.evt : evt;
  let cx, cy;
  if (native && native.touches && native.touches[0]) {
    cx = native.touches[0].clientX;
    cy = native.touches[0].clientY;
  } else if (native && native.changedTouches && native.changedTouches[0]) {
    cx = native.changedTouches[0].clientX;
    cy = native.changedTouches[0].clientY;
  } else if (native && typeof native.clientX === "number") {
    cx = native.clientX;
    cy = native.clientY;
  }
  if (typeof cx !== "number") return stage.getPointerPosition();
  return {
    x: ((cx - box.left) / box.width) * stage.width(),
    y: ((cy - box.top) / box.height) * stage.height(),
  };
}

function onDocDrawMove(e) {
  if (e.cancelable && e.type === "touchmove") e.preventDefault();
  if (state.drawing) extendDraw(e);
}
function onDocDrawUp() {
  endDraw();
}

function endDraw() {
  if (state.drawing) {
    try { state.drawing.node.draggable(true); } catch (_) { /* ignore */ }
    state.drawing = null;
  }
  window.removeEventListener("mousemove", onDocDrawMove, true);
  window.removeEventListener("mouseup", onDocDrawUp, true);
  window.removeEventListener("touchmove", onDocDrawMove, true);
  window.removeEventListener("touchend", onDocDrawUp, true);
}

// ---- Pen & highlighter -----------------------------------------------------
function startDraw(evt) {
  const p = pointer(evt);
  if (!p) return;
  const isHi = state.tool === "highlight";
  const node = new Konva.Line({
    points: [p.x, p.y],
    stroke: isHi ? prop.highlight() : prop.color(),
    strokeWidth: isHi ? Math.max(12, prop.stroke() * 5) : prop.stroke(),
    lineCap: "round",
    lineJoin: "round",
    tension: isHi ? 0 : 0.4,
    opacity: isHi ? 0.4 : 1,
    // Multiply keeps the underlying PDF text readable through the highlight.
    globalCompositeOperation: isHi ? "multiply" : "source-over",
    name: isHi ? "highlight" : "pen",
  });
  state.overlayLayer.add(node);
  state.drawing = { node };
  window.addEventListener("mousemove", onDocDrawMove, true);
  window.addEventListener("mouseup", onDocDrawUp, true);
  window.addEventListener("touchmove", onDocDrawMove, { capture: true, passive: false });
  window.addEventListener("touchend", onDocDrawUp, true);
}
function extendDraw(evt) {
  const p = pointer(evt);
  if (!p || !state.drawing) return;
  state.drawing.node.points(state.drawing.node.points().concat([p.x, p.y]));
  state.overlayLayer.batchDraw();
}

// ---- Text ------------------------------------------------------------------
let textEditor = null;

function addTextAt(p) {
  if (!p) return;
  const node = new Konva.Text({
    x: p.x, y: p.y, text: "Text", fontSize: prop.font(),
    fill: prop.color(), draggable: true, name: "ann-text",
  });
  state.overlayLayer.add(node);
  state.overlayLayer.draw();
  selectTool("select");
  state.transformer.nodes([node]);
  showTextPanel(node);
  editText(node);
}

function closeTextEditor(commit) {
  if (!textEditor) return;
  const { node, area } = textEditor;
  textEditor = null;
  if (commit) node.text(area.value || " ");
  node.show();
  area.remove();
  state.overlayLayer.draw();
  showTextPanel(node);
}

function editText(node) {
  if (!node || node.className !== "Text") return;
  closeTextEditor(true);
  state.transformer.nodes([]);

  const stageBox = state.stage.container().getBoundingClientRect();
  const rect = node.getClientRect();
  const sx = stageBox.width / state.stage.width();
  const sy = stageBox.height / state.stage.height();
  const area = document.createElement("textarea");
  area.className = "text-inline";
  area.value = node.text();
  Object.assign(area.style, {
    position: "fixed",
    left: Math.max(8, stageBox.left + rect.x * sx) + "px",
    top: Math.max(8, stageBox.top + rect.y * sy) + "px",
    minWidth: Math.max(120, rect.width * sx + 16) + "px",
    minHeight: Math.max(32, rect.height * sy + 8) + "px",
    fontSize: Math.max(14, node.fontSize() * (node.scaleY() || 1) * sy) + "px",
    fontFamily: node.fontFamily() || "sans-serif",
    color: node.fill() || "#111",
    lineHeight: "1.25",
    border: "2px solid #4f46e5",
    borderRadius: "6px",
    background: "#fff",
    zIndex: 400,
    padding: "4px 8px",
    margin: "0",
    outline: "none",
    resize: "both",
  });
  document.body.appendChild(area);
  node.hide();
  state.overlayLayer.draw();
  textEditor = { node, area };

  const finish = (commit) => {
    if (!textEditor || textEditor.area !== area) return;
    closeTextEditor(commit);
    state.transformer.nodes([node]);
  };
  area.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
  setTimeout(() => area.addEventListener("blur", () => finish(true)), 80);
  requestAnimationFrame(() => { area.focus(); area.select(); });
}

// ---- Date stamp ------------------------------------------------------------
function stampDate() {
  if (!state.stage || !state.overlayLayer) {
    toast("Open a PDF first");
    return;
  }
  const p = { x: 60, y: 60 };
  const node = new Konva.Text({ x: p.x, y: p.y, text: new Date().toLocaleDateString(),
    fontSize: prop.font(), fill: prop.color(), draggable: true });
  state.overlayLayer.add(node);
  state.overlayLayer.draw();
  // Switch back to select so the stamp can be positioned.
  selectTool("select");
}
function selectTool(t) {
  document.querySelector(`.rail__tool[data-tool="${t}"]`).click();
}

function rgbToHex(c) {
  if (!c) return "#0b3d91";
  if (c[0] === "#") return c.length === 4
    ? "#" + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]
    : c.slice(0, 7);
  const m = String(c).match(/\d+/g);
  if (!m) return "#0b3d91";
  return "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("");
}

function selectedNodes() {
  return (state.transformer?.nodes() || []).slice();
}

function findLinkedHighlight(text) {
  const id = text?.getAttr("markId");
  if (!id || !state.overlayLayer) return null;
  return state.overlayLayer.find(".highlight").find((h) => h.getAttr("markId") === id) || null;
}

function highlightSelectedText(node) {
  const text = node || findTextNode(selectedNodes()[0]);
  if (!text || text.className !== "Text" || !state.overlayLayer) return false;
  const markId = text.getAttr("markId") || ("t" + Date.now().toString(36));
  text.setAttr("markId", markId);
  let band = findLinkedHighlight(text);
  const padX = 6, padY = 3;
  const w = Math.max(12, text.width() * (text.scaleX() || 1) + padX * 2);
  const h = Math.max(10, text.height() * (text.scaleY() || 1) + padY * 2);
  const x = text.x() - padX;
  const y = text.y() - padY;
  if (!band) {
    band = new Konva.Rect({
      x, y, width: w, height: h,
      fill: prop.highlight(),
      opacity: 0.45,
      globalCompositeOperation: "multiply",
      name: "highlight",
      listening: true,
    });
    band.setAttr("markId", markId);
    state.overlayLayer.add(band);
    band.moveToBottom();
  } else {
    band.fill(prop.highlight());
    band.position({ x, y });
    band.size({ width: w, height: h });
  }
  state.overlayLayer.draw();
  return true;
}

function applyInkColor(color) {
  let changed = false;
  selectedNodes().forEach((n) => {
    if (n.className === "Text") { n.fill(color); changed = true; }
    else if (n.hasName("pen") || n.name() === "pen") { n.stroke(color); changed = true; }
  });
  if (textEditor?.area) textEditor.area.style.color = color;
  if (changed && state.overlayLayer) state.overlayLayer.draw();
}

function applyHighlightColor(color) {
  let changed = false;
  selectedNodes().forEach((n) => {
    if (n.hasName("highlight") || n.name() === "highlight") {
      if (n.strokeWidth()) n.stroke(color);
      if (n.fill()) n.fill(color);
      changed = true;
    }
    if (n.className === "Text") {
      highlightSelectedText(n);
      const band = findLinkedHighlight(n);
      if (band) { band.fill(color); changed = true; }
    }
  });
  if (changed && state.overlayLayer) state.overlayLayer.draw();
}

function applyStrokeWidth(w) {
  let changed = false;
  selectedNodes().forEach((n) => {
    if (n.hasName("highlight")) n.strokeWidth(Math.max(12, w * 5));
    else if (n.strokeWidth) n.strokeWidth(w);
    else return;
    changed = true;
  });
  if (changed && state.overlayLayer) state.overlayLayer.draw();
}

function applyFontSize(size) {
  const node = findTextNode(selectedNodes()[0]);
  if (!node) return;
  node.fontSize(size);
  const band = findLinkedHighlight(node);
  if (band) highlightSelectedText(node);
  state.overlayLayer.draw();
}

function syncInspector(node) {
  if (!node) return;
  if (node.className === "Text") {
    if (node.fill()) $("#pe-color").value = rgbToHex(node.fill());
    if (node.fontSize()) $("#pe-font").value = node.fontSize();
    const band = findLinkedHighlight(node);
    if (band?.fill()) $("#pe-highlight").value = rgbToHex(band.fill());
  } else if (node.hasName("highlight") || node.name() === "highlight") {
    const c = node.fill() || node.stroke();
    if (c) $("#pe-highlight").value = rgbToHex(c);
  } else if (node.hasName("pen") || node.name() === "pen") {
    if (node.stroke()) $("#pe-color").value = rgbToHex(node.stroke());
    if (node.strokeWidth()) $("#pe-stroke").value = node.strokeWidth();
  }
}

function wireSwatches(containerSel, inputSel, attr, apply) {
  const box = document.querySelector(containerSel);
  if (!box) return;
  box.querySelectorAll(".swatch[" + attr + "]").forEach((sw) => {
    sw.addEventListener("click", () => {
      box.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-active"));
      sw.classList.add("is-active");
      $(inputSel).value = sw.getAttribute(attr);
      apply?.();
    });
  });
  $(inputSel).addEventListener("input", () => {
    box.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-active"));
    box.querySelector(".swatch--custom")?.classList.add("is-active");
    apply?.();
  });
}
wireSwatches("#pe-color-swatches", "#pe-color", "data-color", () => applyInkColor(prop.color()));
wireSwatches("#pe-hl-swatches", "#pe-highlight", "data-hl", () => applyHighlightColor(prop.highlight()));

$("#pe-text-value")?.addEventListener("input", () => {
  const node = findTextNode(selectedNodes()[0]);
  if (!node) return;
  node.text($("#pe-text-value").value || " ");
  const band = findLinkedHighlight(node);
  if (band) highlightSelectedText(node);
  state.overlayLayer.draw();
});
$("#pe-font")?.addEventListener("input", () => applyFontSize(prop.font()));
$("#pe-stroke")?.addEventListener("input", () => applyStrokeWidth(prop.stroke()));

// ---------------------------------------------------------------------------
// Signature modal (draw / type / upload) -> transparent PNG data URL
// ---------------------------------------------------------------------------
const sig = { dataUrl: null };
function openSigModal() {
  $("#pe-sig-modal").hidden = false;
  setSigTab("draw");
  clearSigPad();
  selectTool("select"); // don't leave the sign tool armed behind the modal
}
function closeSigModal() { $("#pe-sig-modal").hidden = true; }
$("#pe-sig-cancel").addEventListener("click", closeSigModal);

document.querySelectorAll(".seg__btn").forEach((t) =>
  t.addEventListener("click", () => setSigTab(t.dataset.sig)));
function setSigTab(name) {
  document.querySelectorAll(".seg__btn").forEach((t) => t.classList.toggle("is-active", t.dataset.sig === name));
  document.querySelectorAll(".sig-pane").forEach((p) => (p.hidden = p.dataset.pane !== name));
}

// Draw pad
const pad = $("#pe-sigpad");
const pctx = pad.getContext("2d");
let padDrawing = false, padHasInk = false;
function clearSigPad() { pctx.clearRect(0, 0, pad.width, pad.height); padHasInk = false; }
function padPos(e) {
  const r = pad.getBoundingClientRect();
  const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
  const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
  return { x: cx * (pad.width / r.width), y: cy * (pad.height / r.height) };
}
pad.addEventListener("mousedown", (e) => { padDrawing = true; const p = padPos(e); pctx.beginPath(); pctx.moveTo(p.x, p.y); });
pad.addEventListener("mousemove", (e) => {
  if (!padDrawing) return; const p = padPos(e);
  pctx.strokeStyle = prop.color(); pctx.lineWidth = 2.5; pctx.lineCap = "round";
  pctx.lineTo(p.x, p.y); pctx.stroke(); padHasInk = true;
});
window.addEventListener("mouseup", () => (padDrawing = false));
$("#pe-sig-clear").addEventListener("click", clearSigPad);

// Type
$("#pe-sig-text").addEventListener("input", (e) => {
  $("#pe-sig-preview").textContent = e.target.value || "Your Signature";
  $("#pe-sig-preview").style.color = prop.color();
});

// Upload
let uploadDataUrl = null;
$("#pe-sig-file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) uploadDataUrl = await U.blobToDataUrl(f);
});

// Produce the signature image for the active tab.
async function buildSignature() {
  const active = document.querySelector(".seg__btn.is-active").dataset.sig;
  if (active === "draw") {
    if (!padHasInk) return null;
    return pad.toDataURL("image/png");
  }
  if (active === "type") {
    const text = $("#pe-sig-text").value.trim();
    if (!text) return null;
    const c = document.createElement("canvas");
    c.width = 600; c.height = 160;
    const x = c.getContext("2d");
    x.fillStyle = prop.color();
    x.font = '64px "Segoe Script", "Brush Script MT", cursive';
    x.textBaseline = "middle";
    x.fillText(text, 12, 88);
    return c.toDataURL("image/png");
  }
  if (active === "upload") return uploadDataUrl;
  return null;
}

$("#pe-sig-add").addEventListener("click", async () => {
  const dataUrl = await buildSignature();
  if (!dataUrl) return toast("Add a signature first");
  closeSigModal();
  placeSignature(dataUrl);
});

// Add the signature as a draggable/resizable image, centred on the page.
function placeSignature(dataUrl) {
  if (!state.stage || !state.overlayLayer) {
    toast("Open a PDF first");
    return;
  }
  const im = new Image();
  im.onload = () => {
    const maxW = state.stage.width() * 0.35;
    const scale = Math.min(1, maxW / im.width);
    const w = im.width * scale, h = im.height * scale;
    const node = new Konva.Image({
      image: im, x: (state.stage.width() - w) / 2, y: (state.stage.height() - h) / 2,
      width: w, height: h, draggable: true, name: "sig",
    });
    node.setAttr("srcDataUrl", dataUrl); // so it survives page-switch serialization
    state.overlayLayer.add(node);
    state.transformer.nodes([node]);
    state.overlayLayer.draw();
    toast("Drag the signature onto the spot, resize with the handles.");
  };
  im.src = dataUrl;
}

// ---------------------------------------------------------------------------
// Save: overlay each annotated page onto the ORIGINAL PDF via pdf-lib
// ---------------------------------------------------------------------------
$("#pe-save").addEventListener("click", exportPdf);

async function exportPdf() {
  try {
    progress("Preparing…", 0.1);
    saveAllOverlays();

    const { PDFDocument } = PDFLib;
    const pdf = await PDFDocument.load(state.pdfBytes);
    const pages = pdf.getPages();

    const annotated = Object.keys(state.pageOverlays);
    for (let i = 0; i < annotated.length; i++) {
      const num = +annotated[i];
      progress("Embedding page " + num + "…", 0.1 + 0.8 * (i / annotated.length));
      const pngDataUrl = await overlayPng(num);
      if (!pngDataUrl) continue;
      const png = await pdf.embedPng(pngDataUrl);
      const page = pages[num - 1];
      const { width, height } = page.getSize();
      page.drawImage(png, { x: 0, y: 0, width, height });
    }

    // Stamp the "AK" acknowledgement — italic, signature-style — on every page.
    if (state.acknowledge) {
      const font = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBoldOblique);
      const size = 22;
      const ink = PDFLib.rgb(0.31, 0.27, 0.9);
      const tw = font.widthOfTextAtSize("AK", size);
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const { width } = page.getSize();
        // Render the page to detect which bottom corner is free (don't overwrite).
        let side = "right";
        try {
          const pg = await state.pdfDoc.getPage(i + 1);
          const vp = pg.getViewport({ scale: 1 });
          const c = document.createElement("canvas");
          c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
          await pg.render({ canvasContext: c.getContext("2d", { willReadFrequently: true }), viewport: vp }).promise;
          side = chooseAckSide(c);
        } catch (_) { /* default right */ }
        const x = side === "right" ? width - tw - 40 : 40;
        const y = 24;
        page.drawText("AK", { x, y, size, font, color: ink });
        page.drawLine({ start: { x: x - 3, y: y - 4 }, end: { x: x + tw + 3, y: y - 4 }, thickness: 1.2, color: ink });
      }
    }

    progress("Saving…", 0.95);
    const bytes = await pdf.save();
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const outName = state.fileName.replace(/\.pdf$/i, "") + "-signed.pdf";
    await chrome.downloads.download({ url, filename: outName, saveAs: true });
    hideProgress();
    toast("Saved " + outName);
  } catch (err) {
    hideProgress();
    console.error(err);
    toast("Save failed: " + err.message);
  }
}

// Render one page's overlays to a transparent PNG at that page's pixel size.
async function overlayPng(num) {
  const size = state.pageSizes[num];
  const json = state.pageOverlays[num];
  if (!size || !json) return null;

  const parsed = JSON.parse(json);
  if (!parsed.children || parsed.children.length === 0) return null;

  // Build an offscreen stage so we can rasterize without disturbing the view.
  const holder = document.createElement("div");
  holder.style.position = "fixed";
  holder.style.left = "-99999px";
  document.body.appendChild(holder);
  const stage = new Konva.Stage({ container: holder, width: size.w, height: size.h });
  const layer = new Konva.Layer();
  stage.add(layer);

  // Recreate nodes, re-attaching signature images and waiting for them to load.
  const pending = [];
  (parsed.children || []).forEach((cfg) => {
    const node = Konva.Node.create(JSON.stringify(cfg));
    const imgs = node.className === "Image" ? [node] : (node.find ? node.find("Image") : []);
    imgs.forEach((kimg) => {
      const src = kimg.getAttr("srcDataUrl");
      if (src) pending.push(new Promise((res) => {
        const im = new Image(); im.onload = () => { kimg.image(im); res(); }; im.onerror = res; im.src = src;
      }));
    });
    layer.add(node);
  });
  await Promise.all(pending);
  layer.draw();

  const dataUrl = stage.toDataURL({ pixelRatio: size.dpr || 1, mimeType: "image/png" });
  stage.destroy();
  holder.remove();
  return dataUrl;
}

// Expose a couple of internals for E2E tests.
window.__pdfEditor = { state, openPdf, exportPdf, chooseAckSide, editText, addTextAt, goToPage };
