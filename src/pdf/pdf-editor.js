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

// Render at 1.5x for crisp on-screen editing; overlays are exported at this
// same pixel size and scaled to the page's point size on save.
const RENDER_SCALE = 1.5;

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
};

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
  state.pdfDoc = await pdfjsLib.getDocument({ data: state.pdfBytes.slice() }).promise;
  state.numPages = state.pdfDoc.numPages;
  state.pageNum = 1;
  state.pageOverlays = {};
  state.pageSizes = {};
  const chip = $("#pe-file");
  chip.textContent = state.fileName;
  chip.hidden = false;
  $("#pe-empty").hidden = true;
  $("#pe-save").disabled = false;
  await renderPage(1);
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
// Render a page onto the Konva stage
// ---------------------------------------------------------------------------
async function renderPage(num) {
  // Save current page overlays before switching.
  if (state.overlayLayer) saveOverlay(state.pageNum);

  state.pageNum = num;
  const page = await state.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: RENDER_SCALE });

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  state.pageSizes[num] = { w: canvas.width, h: canvas.height };

  // (Re)build the stage at the page size.
  if (state.stage) state.stage.destroy();
  state.stage = new Konva.Stage({ container: "pe-stage", width: canvas.width, height: canvas.height });
  state.baseLayer = new Konva.Layer({ listening: false });
  state.overlayLayer = new Konva.Layer();
  state.stage.add(state.baseLayer, state.overlayLayer);
  state.baseLayer.add(new Konva.Image({ image: canvas, width: canvas.width, height: canvas.height }));
  state.baseLayer.draw();

  state.transformer = new Konva.Transformer({ rotateEnabled: true, ignoreStroke: true });
  state.overlayLayer.add(state.transformer);

  // A separate top layer for the AK acknowledgement badge (never serialized).
  state.ackLayer = new Konva.Layer({ listening: false });
  state.stage.add(state.ackLayer);

  // Restore any overlays previously placed on this page.
  loadOverlay(num);
  bindStage();
  drawAck();
  state.baseLayer.draw();
  state.overlayLayer.draw();
}

// Draw (or clear) the on-screen "AK" badge at the bottom-centre of the page.
function drawAck() {
  if (!state.ackLayer) return;
  state.ackLayer.destroyChildren();
  if (state.acknowledge && state.stage) {
    const W = state.stage.width();
    const H = state.stage.height();
    // Signature-style: cursive + italic "AK" with an underline, bottom-centre.
    const text = new Konva.Text({
      text: "AK", fontSize: 30, fontStyle: "italic bold",
      fontFamily: '"Segoe Script","Snell Roundhand","Brush Script MT",cursive',
      fill: "#4f46e5",
    });
    const tw = text.width();
    const x = (W - tw) / 2, y = H - 52;
    text.position({ x, y });
    const underline = new Konva.Line({
      points: [x - 4, y + 34, x + tw + 4, y + 34], stroke: "#4f46e5", strokeWidth: 1.5, lineCap: "round",
    });
    state.ackLayer.add(underline, text);
  }
  state.ackLayer.draw();
}

// Toggle the acknowledgement.
document.addEventListener("DOMContentLoaded", () => {}); // noop guard for order
function wireAck() {
  const btn = $("#pe-ack");
  if (!btn) return;
  btn.addEventListener("click", () => {
    state.acknowledge = !state.acknowledge;
    btn.classList.toggle("is-active", state.acknowledge);
    drawAck();
    toast(state.acknowledge ? "AK will be stamped on every page" : "Acknowledgement removed");
  });
}
wireAck();

function saveOverlay(num) {
  if (!state.overlayLayer) return;
  state.transformer.nodes([]);
  // Serialize only real annotations (skip the transformer).
  const clone = state.overlayLayer.clone();
  clone.find("Transformer").forEach((t) => t.destroy());
  state.pageOverlays[num] = clone.toJSON();
}

function loadOverlay(num) {
  const json = state.pageOverlays[num];
  if (!json) return;
  const parsed = JSON.parse(json);
  (parsed.children || []).forEach((childCfg) => {
    const node = Konva.Node.create(JSON.stringify(childCfg));
    // Images serialize without pixels; re-attach from the stored data URL.
    reviveImages(node);
    node.draggable(true);
    state.overlayLayer.add(node);
  });
}

// Konva.Image loses its bitmap through JSON; we stash the data URL in attrs.
function reviveImages(node) {
  const imgs = node.className === "Image" ? [node] : (node.find ? node.find("Image") : []);
  imgs.forEach((kimg) => {
    const src = kimg.getAttr("srcDataUrl");
    if (src) {
      const im = new Image();
      im.onload = () => { kimg.image(im); state.overlayLayer.draw(); };
      im.src = src;
    }
  });
}

// ---------------------------------------------------------------------------
// Pager
// ---------------------------------------------------------------------------
function updatePager() {
  $("#pe-pageinfo").textContent = `${state.pageNum} / ${state.numPages}`;
  $("#pe-prev").disabled = state.pageNum <= 1;
  $("#pe-next").disabled = state.pageNum >= state.numPages;
}
$("#pe-prev").addEventListener("click", async () => {
  if (state.pageNum > 1) { await renderPage(state.pageNum - 1); updatePager(); }
});
$("#pe-next").addEventListener("click", async () => {
  if (state.pageNum < state.numPages) { await renderPage(state.pageNum + 1); updatePager(); }
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
document.querySelectorAll(".rail__tool[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".rail__tool[data-tool]").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.tool = btn.dataset.tool;
    if (state.transformer) state.transformer.nodes([]);
    if (state.stage) state.stage.container().style.cursor = state.tool === "select" ? "default" : "crosshair";
    if (state.tool === "sign") openSigModal();
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
  const nodes = state.transformer?.nodes() || [];
  nodes.forEach((n) => n.destroy());
  state.transformer.nodes([]);
  state.overlayLayer.draw();
}

function bindStage() {
  const stage = state.stage;
  stage.on("mousedown touchstart", (e) => {
    if (state.tool === "select") {
      if (e.target === stage || e.target.getParent()?.className !== "Transformer" &&
          e.target.getLayer() === state.baseLayer) state.transformer.nodes([]);
      return;
    }
    if (state.tool === "pen" || state.tool === "highlight") startDraw();
  });
  stage.on("mousemove touchmove", () => { if (state.drawing) extendDraw(); });
  stage.on("mouseup touchend", () => { if (state.drawing) { state.drawing.node.draggable(true); state.drawing = null; } });

  stage.on("click tap", (e) => {
    if (state.tool !== "select") return;
    if (e.target.getLayer() === state.baseLayer || e.target === stage) return;
    if (e.target.getParent()?.className === "Transformer") return;
    const target = e.target.getParent()?.hasName && e.target.getParent().hasName("sig") ? e.target.getParent() : e.target;
    state.transformer.nodes([target]);
  });

  stage.on("dblclick dbltap", (e) => { if (e.target.className === "Text") editText(e.target); });

  if (state.tool === "text") {
    stage.off("click.addtext");
    stage.on("click.addtext", () => { if (state.tool === "text") addTextAt(pointer()); });
  }
}

function pointer() { return state.stage.getPointerPosition(); }

// ---- Pen & highlighter -----------------------------------------------------
function startDraw() {
  const p = pointer();
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
}
function extendDraw() {
  const p = pointer();
  state.drawing.node.points(state.drawing.node.points().concat([p.x, p.y]));
  state.overlayLayer.batchDraw();
}

// ---- Text ------------------------------------------------------------------
function addTextAt(p) {
  const node = new Konva.Text({ x: p.x, y: p.y, text: "Text", fontSize: prop.font(),
    fill: prop.color(), draggable: true });
  state.overlayLayer.add(node);
  state.overlayLayer.draw();
  editText(node);
}
function editText(node) {
  const box = state.stage.container().getBoundingClientRect();
  const area = document.createElement("textarea");
  document.body.appendChild(area);
  area.value = node.text();
  Object.assign(area.style, {
    position: "absolute", top: box.top + window.scrollY + node.y() + "px",
    left: box.left + window.scrollX + node.x() + "px", fontSize: node.fontSize() + "px",
    color: node.fill(), border: "1px solid #3b82f6", background: "#fff", zIndex: 200, padding: "2px",
  });
  node.hide(); state.overlayLayer.draw(); area.focus(); area.select();
  const done = () => { node.text(area.value || " "); node.show(); area.remove(); state.overlayLayer.draw(); };
  area.addEventListener("blur", done);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); area.blur(); }
    if (e.key === "Escape") { area.value = node.text(); area.blur(); }
  });
}

// ---- Date stamp ------------------------------------------------------------
function stampDate() {
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

// Colour swatches (ink + highlighter) drive the hidden <input type=color>.
function wireSwatches(containerSel, inputSel, attr) {
  const box = document.querySelector(containerSel);
  if (!box) return;
  box.querySelectorAll(".swatch[" + attr + "]").forEach((sw) => {
    sw.addEventListener("click", () => {
      box.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-active"));
      sw.classList.add("is-active");
      $(inputSel).value = sw.getAttribute(attr);
    });
  });
  // A custom-colour pick clears preset highlight and marks the custom chip active.
  $(inputSel).addEventListener("input", () => {
    box.querySelectorAll(".swatch").forEach((s) => s.classList.remove("is-active"));
    box.querySelector(".swatch--custom")?.classList.add("is-active");
  });
}
wireSwatches("#pe-color-swatches", "#pe-color", "data-color");
wireSwatches("#pe-hl-swatches", "#pe-highlight", "data-hl");

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
    saveOverlay(state.pageNum); // capture the visible page's overlays

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
      pages.forEach((page) => {
        const { width } = page.getSize();
        const tw = font.widthOfTextAtSize("AK", size);
        const x = (width - tw) / 2;
        const y = 24;
        page.drawText("AK", { x, y, size, font, color: ink });
        // A signature-like underline stroke beneath the mark.
        page.drawLine({ start: { x: x - 3, y: y - 4 }, end: { x: x + tw + 3, y: y - 4 }, thickness: 1.2, color: ink });
      });
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

  const dataUrl = stage.toDataURL({ pixelRatio: 1, mimeType: "image/png" });
  stage.destroy();
  holder.remove();
  return dataUrl;
}

// Expose a couple of internals for E2E tests.
window.__pdfEditor = { state, openPdf, exportPdf };
