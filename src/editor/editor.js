// ============================================================================
// SnapShot Studio — Editor
// A Konva-based canvas editor: crop, annotate, backgrounds, OCR, QR, export.
// Loads a capture stashed by the service worker (?id=…) or starts blank / from
// a dropped image.
// ============================================================================

/* global Konva, jspdf, jsQR, Tesseract */

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);

// Shared helpers + device profile (adapts raster resolution & OCR to the machine).
const U = window.SnapShotUtils;
const DEVICE = U.deviceProfile();

// ---- UI helpers ------------------------------------------------------------
function toast(msg, ms = 2000) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function showProgress(label, pct) {
  const p = $("#progress");
  p.hidden = false;
  $("#progress-label").textContent = label;
  $("#progress-bar").style.width = Math.round(pct * 100) + "%";
}
function hideProgress() { $("#progress").hidden = true; }

// ---- Editor state ----------------------------------------------------------
const state = {
  stage: null,
  bgLayer: null,
  contentLayer: null,
  content: null,     // Konva.Group holding base image + annotations, offset by padding
  baseImage: null,   // Konva.Image
  transformer: null,
  imgW: 0,
  imgH: 0,
  tool: "select",
  stepCount: 0,
  undoStack: [],
  drawing: null,
};

const props = {
  color: () => $("#prop-color").value,
  stroke: () => +$("#prop-stroke").value,
  font: () => +$("#prop-font").value,
  blur: () => +$("#prop-blur").value,
  pad: () => +$("#prop-pad").value,
  radius: () => +$("#prop-radius").value,
  shadow: () => $("#prop-shadow").checked,
  bgtype: () => $("#prop-bgtype").value,
  bgcolor: () => $("#prop-bgcolor").value,
  bgcolor2: () => $("#prop-bgcolor2").value,
  blurmode: () => document.querySelector('input[name="blurmode"]:checked').value,
  textblur: () => $("#prop-textblur").checked,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  const id = params.get("id");
  if (id) {
    const key = "capture:" + id;
    const stored = (await chrome.storage.local.get(key))[key];
    if (stored) {
      $("#mode-label").textContent = stored.meta?.kind ? "· " + stored.meta.kind : "";
      const img = await loadImage(stored.dataUrl);
      const final = stored.meta?.cropRect
        ? cropSource(img, stored.meta.cropRect)
        : img;
      initStage(final);
      // Free the storage entry once loaded.
      chrome.storage.local.remove(key);
      return;
    }
  }
  // Blank editor: wait for a dropped image.
  $("#empty-state").hidden = false;
  setupDropZone();
}

const loadImage = U.loadImage;

// Crop an area selection out of the full visible-tab capture.
function cropSource(img, rect) {
  const c = document.createElement("canvas");
  c.width = rect.width;
  c.height = rect.height;
  c.getContext("2d").drawImage(
    img, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height
  );
  const out = new Image();
  out.src = c.toDataURL("image/png");
  return out.decode ? out.decode().then(() => out) : out;
}

function setupDropZone() {
  const wrap = $("#stage-wrap");
  wrap.addEventListener("dragover", (e) => e.preventDefault());
  wrap.addEventListener("drop", async (e) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    initStage(await loadImage(url));
    $("#empty-state").hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Stage setup
// ---------------------------------------------------------------------------
async function initStage(img) {
  // img may be a promise-ish from cropSource
  if (img && typeof img.then === "function") img = await img;
  $("#empty-state").hidden = true;

  state.imgW = img.naturalWidth || img.width;
  state.imgH = img.naturalHeight || img.height;

  state.stage = new Konva.Stage({
    container: "stage",
    width: state.imgW,
    height: state.imgH,
  });

  state.bgLayer = new Konva.Layer();
  state.contentLayer = new Konva.Layer();
  state.stage.add(state.bgLayer, state.contentLayer);

  state.content = new Konva.Group({ x: 0, y: 0 });
  state.contentLayer.add(state.content);

  state.baseImage = new Konva.Image({
    image: img, x: 0, y: 0, width: state.imgW, height: state.imgH, name: "base",
  });
  state.content.add(state.baseImage);

  state.transformer = new Konva.Transformer({ rotateEnabled: true, ignoreStroke: true });
  state.contentLayer.add(state.transformer);

  layoutFrame();
  bindStageEvents();
  pushUndo();
}

// Recompute stage size, background and content offset from padding/radius/shadow.
function layoutFrame() {
  const pad = props.pad();
  const W = state.imgW + pad * 2;
  const H = state.imgH + pad * 2;
  state.stage.width(W);
  state.stage.height(H);
  state.content.position({ x: pad, y: pad });

  // Rounded corners on the base image via corner-radius clip.
  const r = props.radius();
  state.baseImage.cornerRadius ? state.baseImage.cornerRadius(r) : null;
  if (props.shadow()) {
    state.baseImage.shadowColor("black");
    state.baseImage.shadowBlur(30);
    state.baseImage.shadowOpacity(0.35);
    state.baseImage.shadowOffset({ x: 0, y: 10 });
  } else {
    state.baseImage.shadowBlur(0);
    state.baseImage.shadowOpacity(0);
  }

  // Background fill.
  state.bgLayer.destroyChildren();
  const type = props.bgtype();
  if (type !== "none") {
    const rect = new Konva.Rect({ x: 0, y: 0, width: W, height: H });
    if (type === "solid") {
      rect.fill(props.bgcolor());
    } else {
      rect.fillLinearGradientStartPoint({ x: 0, y: 0 });
      rect.fillLinearGradientEndPoint({ x: W, y: H });
      rect.fillLinearGradientColorStops([0, props.bgcolor(), 1, props.bgcolor2()]);
    }
    state.bgLayer.add(rect);
  }
  state.bgLayer.draw();
  state.contentLayer.draw();
}

// Debounce frame relayout to one redraw per animation frame while dragging
// sliders — keeps padding/radius/gradient smooth even on low-power devices.
const layoutFrameRAF = U.rafDebounce(layoutFrame);
["prop-pad", "prop-radius", "prop-shadow", "prop-bgtype", "prop-bgcolor", "prop-bgcolor2"]
  .forEach((id) => $("#" + id).addEventListener("input", layoutFrameRAF));

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
document.querySelectorAll(".ed-tool").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ed-tool").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.tool = btn.dataset.tool;
    state.transformer.nodes([]);
    $("#btn-crop-apply").disabled = state.tool !== "crop";
    state.stage.container().style.cursor =
      state.tool === "select" ? "default" : "crosshair";
  });
});

function contentPointer() {
  // Pointer position in content (image) coordinates.
  const p = state.stage.getPointerPosition();
  const pad = props.pad();
  return { x: p.x - pad, y: p.y - pad };
}

function bindStageEvents() {
  const stage = state.stage;

  stage.on("mousedown touchstart", (e) => {
    if (state.tool === "select") {
      // Click empty space clears selection.
      if (e.target === state.baseImage || e.target === stage) state.transformer.nodes([]);
      return;
    }
    const pos = contentPointer();
    startDrawing(pos);
  });

  stage.on("mousemove touchmove", () => {
    if (!state.drawing) return;
    updateDrawing(contentPointer());
  });

  stage.on("mouseup touchend", () => {
    if (state.drawing) finishDrawing();
  });

  // Selecting a shape with the select tool.
  stage.on("click tap", (e) => {
    if (state.tool !== "select") return;
    if (e.target === state.baseImage || e.target === stage) return;
    if (e.target.getParent() === state.transformer) return;
    state.transformer.nodes([e.target]);
    syncPropsFromNode(e.target);
  });

  // Double-click text to edit.
  stage.on("dblclick dbltap", (e) => {
    if (e.target.className === "Text") editText(e.target);
  });
}

function startDrawing(pos) {
  const t = state.tool;
  const color = props.color();
  const sw = props.stroke();
  let node;

  switch (t) {
    case "arrow":
      node = new Konva.Arrow({
        points: [pos.x, pos.y, pos.x, pos.y], stroke: color, fill: color,
        strokeWidth: sw, pointerLength: 12, pointerWidth: 12,
      });
      break;
    case "rect":
      node = new Konva.Rect({
        x: pos.x, y: pos.y, width: 0, height: 0, stroke: color, strokeWidth: sw,
      });
      break;
    case "oval":
      node = new Konva.Ellipse({
        x: pos.x, y: pos.y, radiusX: 0, radiusY: 0, stroke: color, strokeWidth: sw,
      });
      break;
    case "line":
      node = new Konva.Line({
        points: [pos.x, pos.y], stroke: color, strokeWidth: sw,
        lineCap: "round", lineJoin: "round", tension: 0.4,
      });
      break;
    case "highlight":
      node = new Konva.Line({
        points: [pos.x, pos.y], stroke: color, strokeWidth: sw * 4,
        lineCap: "round", lineJoin: "round", opacity: 0.35,
        globalCompositeOperation: "multiply",
      });
      break;
    case "text": {
      addText(pos, color);
      return;
    }
    case "step": {
      addStep(pos, color);
      return;
    }
    case "spotlight":
      node = makeSpotlight(pos);
      break;
    case "blur":
      node = new Konva.Rect({
        x: pos.x, y: pos.y, width: 0, height: 0,
        stroke: "#3b82f6", strokeWidth: 1, dash: [4, 4], name: "blur-marquee",
      });
      break;
    case "crop":
      node = new Konva.Rect({
        x: pos.x, y: pos.y, width: 0, height: 0,
        stroke: "#3b82f6", strokeWidth: 2, dash: [6, 4],
        fill: "rgba(59,130,246,0.1)", name: "crop-marquee",
      });
      break;
    default:
      return;
  }
  state.content.add(node);
  state.drawing = { node, start: pos, tool: t };
}

function updateDrawing(pos) {
  const { node, start, tool } = state.drawing;
  switch (tool) {
    case "arrow":
      node.points([start.x, start.y, pos.x, pos.y]);
      break;
    case "rect": case "blur": case "crop": {
      node.x(Math.min(start.x, pos.x));
      node.y(Math.min(start.y, pos.y));
      node.width(Math.abs(pos.x - start.x));
      node.height(Math.abs(pos.y - start.y));
      break;
    }
    case "oval":
      node.x((start.x + pos.x) / 2);
      node.y((start.y + pos.y) / 2);
      node.radiusX(Math.abs(pos.x - start.x) / 2);
      node.radiusY(Math.abs(pos.y - start.y) / 2);
      break;
    case "line": case "highlight":
      node.points(node.points().concat([pos.x, pos.y]));
      break;
    case "spotlight":
      updateSpotlight(node, start, pos);
      break;
  }
  state.contentLayer.batchDraw();
}

function finishDrawing() {
  const { node, tool } = state.drawing;
  state.drawing = null;

  if (tool === "blur") {
    const rect = node.getClientRect({ relativeTo: state.content });
    node.destroy();
    if (rect.width > 4 && rect.height > 4) applyBlur(rect);
  } else if (tool === "crop") {
    // Leave the marquee; "Apply crop" reads it.
    node.name("crop-marquee-final");
  } else {
    node.draggable(true);
  }
  state.contentLayer.batchDraw();
  pushUndo();
}

// ---- Text ------------------------------------------------------------------
function addText(pos, color) {
  const node = new Konva.Text({
    x: pos.x, y: pos.y, text: "Text", fontSize: props.font(),
    fill: color, draggable: true, fontStyle: "bold",
  });
  state.content.add(node);
  state.contentLayer.draw();
  editText(node);
  pushUndo();
}

function editText(textNode) {
  const stageBox = state.stage.container().getBoundingClientRect();
  const pad = props.pad();
  const area = document.createElement("textarea");
  document.body.appendChild(area);
  area.value = textNode.text();
  Object.assign(area.style, {
    position: "absolute",
    top: stageBox.top + window.scrollY + (textNode.y() + pad) + "px",
    left: stageBox.left + window.scrollX + (textNode.x() + pad) + "px",
    fontSize: textNode.fontSize() + "px",
    color: textNode.fill(),
    border: "1px solid #3b82f6", background: "white", zIndex: 100,
    fontFamily: "sans-serif", padding: "2px", minWidth: "60px",
  });
  textNode.hide();
  state.contentLayer.draw();
  area.focus();
  area.select();
  const done = () => {
    textNode.text(area.value || " ");
    textNode.show();
    area.remove();
    state.contentLayer.draw();
    pushUndo();
  };
  area.addEventListener("blur", done);
  area.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); area.blur(); }
    if (e.key === "Escape") { area.value = textNode.text(); area.blur(); }
  });
}

// ---- Step counter ----------------------------------------------------------
function addStep(pos, color) {
  state.stepCount += 1;
  const g = new Konva.Group({ x: pos.x, y: pos.y, draggable: true, name: "step" });
  const r = Math.max(16, props.font() * 0.7);
  g.add(new Konva.Circle({ radius: r, fill: color }));
  g.add(new Konva.Text({
    text: String(state.stepCount), fontSize: r, fill: "#fff", fontStyle: "bold",
    width: r * 2, height: r * 2, align: "center", verticalAlign: "middle",
    offsetX: r, offsetY: r,
  }));
  state.content.add(g);
  state.contentLayer.draw();
  pushUndo();
}
$("#btn-reset-step").addEventListener("click", () => { state.stepCount = 0; toast("Step counter reset"); });

// ---- Spotlight -------------------------------------------------------------
function makeSpotlight(pos) {
  const W = state.imgW, H = state.imgH;
  const g = new Konva.Group({ name: "spotlight", draggable: false });
  g.add(new Konva.Rect({ x: 0, y: 0, width: W, height: H, fill: "black", opacity: 0.55 }));
  g.add(new Konva.Ellipse({
    x: pos.x, y: pos.y, radiusX: 0, radiusY: 0, fill: "black",
    globalCompositeOperation: "destination-out", name: "hole",
  }));
  return g;
}
function updateSpotlight(g, start, pos) {
  const hole = g.findOne(".hole");
  hole.x((start.x + pos.x) / 2);
  hole.y((start.y + pos.y) / 2);
  hole.radiusX(Math.abs(pos.x - start.x) / 2);
  hole.radiusY(Math.abs(pos.y - start.y) / 2);
}

// ---- Blur / pixelate -------------------------------------------------------
function applyBlur(rect) {
  const region = clampRect(rect, state.imgW, state.imgH);
  if (region.width < 2 || region.height < 2) return;
  const src = getBaseCanvas();
  const mode = props.blurmode();
  const out = document.createElement("canvas");
  out.width = region.width;
  out.height = region.height;
  const octx = out.getContext("2d");

  if (mode === "pixelate") {
    const block = Math.max(4, Math.round(props.blur() / 2));
    const smallW = Math.max(1, Math.round(region.width / block));
    const smallH = Math.max(1, Math.round(region.height / block));
    octx.imageSmoothingEnabled = false;
    octx.drawImage(src, region.x, region.y, region.width, region.height, 0, 0, smallW, smallH);
    octx.drawImage(out, 0, 0, smallW, smallH, 0, 0, region.width, region.height);
  } else {
    octx.filter = `blur(${props.blur()}px)`;
    octx.drawImage(src, region.x, region.y, region.width, region.height, 0, 0, region.width, region.height);
  }
  const kimg = new Konva.Image({
    image: out, x: region.x, y: region.y, width: region.width, height: region.height,
    draggable: true, name: "blur-patch",
  });
  state.content.add(kimg);
  state.contentLayer.draw();
}

// Render just the base image to a plain canvas for sampling (blur / OCR / QR).
function getBaseCanvas() {
  const c = document.createElement("canvas");
  c.width = state.imgW;
  c.height = state.imgH;
  c.getContext("2d").drawImage(state.baseImage.image(), 0, 0, state.imgW, state.imgH);
  return c;
}
const clampRect = U.clampRect;

// ---- Crop ------------------------------------------------------------------
$("#btn-crop-apply").addEventListener("click", () => {
  const marquee = state.content.findOne(".crop-marquee-final") || state.content.findOne(".crop-marquee");
  if (!marquee) return toast("Draw a crop rectangle first");
  const r = clampRect(marquee.getClientRect({ relativeTo: state.content }), state.imgW, state.imgH);
  marquee.destroy();
  if (r.width < 4 || r.height < 4) return;

  // Flatten current content (image + annotations) then crop.
  state.transformer.nodes([]);
  const full = state.content.toCanvas({ pixelRatio: 1 });
  const c = document.createElement("canvas");
  c.width = r.width;
  c.height = r.height;
  c.getContext("2d").drawImage(full, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
  const newImg = new Image();
  newImg.onload = () => {
    // Rebuild the stage around the cropped image.
    state.content.destroyChildren();
    state.imgW = r.width;
    state.imgH = r.height;
    state.baseImage = new Konva.Image({ image: newImg, width: r.width, height: r.height, name: "base" });
    state.content.add(state.baseImage);
    state.contentLayer.add(state.transformer);
    layoutFrame();
    pushUndo();
    toast("Cropped");
  };
  newImg.src = c.toDataURL();
});

// ---------------------------------------------------------------------------
// Selection helpers, undo, delete
// ---------------------------------------------------------------------------
function syncPropsFromNode(node) {
  if (node.stroke && node.stroke()) $("#prop-color").value = rgbToHex(node.stroke());
  if (node.className === "Text" && node.fill()) $("#prop-color").value = rgbToHex(node.fill());
}
function rgbToHex(c) {
  if (!c) return "#ef4444";
  if (c[0] === "#") return c.length === 7 ? c : "#ef4444";
  const m = c.match(/\d+/g);
  if (!m) return "#ef4444";
  return "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("");
}

// Live-apply style changes to the selected node.
["prop-color", "prop-stroke", "prop-font"].forEach((id) =>
  $("#" + id).addEventListener("input", () => {
    const nodes = state.transformer.nodes();
    nodes.forEach((n) => {
      if (id === "prop-color") {
        if (n.className === "Text") n.fill(props.color());
        else { n.stroke && n.stroke(props.color()); n.fill && n.className === "Arrow" && n.fill(props.color()); }
      }
      if (id === "prop-stroke" && n.strokeWidth) n.strokeWidth(props.stroke());
      if (id === "prop-font" && n.fontSize) n.fontSize(props.font());
    });
    state.contentLayer.batchDraw();
  })
);

$("#btn-delete").addEventListener("click", () => {
  const nodes = state.transformer.nodes();
  if (!nodes.length) return;
  nodes.forEach((n) => n.destroy());
  state.transformer.nodes([]);
  state.contentLayer.draw();
  pushUndo();
});

function pushUndo() {
  if (!state.content) return;
  try {
    // Snapshot annotation nodes (everything except the base image).
    const json = state.content.toJSON();
    state.undoStack.push(json);
    if (state.undoStack.length > 40) state.undoStack.shift();
  } catch (_) { /* ignore */ }
}

$("#btn-undo").addEventListener("click", () => {
  if (state.undoStack.length < 2) return toast("Nothing to undo");
  state.undoStack.pop(); // current
  // Simplest reliable undo: remove the most-recently added annotation.
  const anns = state.content.getChildren((n) => n !== state.baseImage);
  const last = anns[anns.length - 1];
  if (last) { last.destroy(); state.transformer.nodes([]); state.contentLayer.draw(); }
});

document.addEventListener("keydown", (e) => {
  if ((e.key === "Delete" || e.key === "Backspace") && state.transformer?.nodes().length) {
    if (document.activeElement.tagName === "TEXTAREA" || document.activeElement.tagName === "INPUT") return;
    e.preventDefault();
    $("#btn-delete").click();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "z") { e.preventDefault(); $("#btn-undo").click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === "c") { $("#btn-copy").click(); }
});

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function flatten(mime = "image/png", quality = 0.92) {
  state.transformer.nodes([]);
  state.contentLayer.draw();
  // Render at the base image's own resolution (pixelRatio 1) so exports are
  // 1:1 with the capture and memory stays bounded on all devices.
  return state.stage.toCanvas({ pixelRatio: 1 }).toDataURL(mime, quality);
}

function downloadDataUrl(dataUrl, filename) {
  chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}
function stamp() { return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); }

$("#btn-png").addEventListener("click", () => downloadDataUrl(flatten("image/png"), `SnapShot-${stamp()}.png`));
$("#btn-jpg").addEventListener("click", () => downloadDataUrl(flatten("image/jpeg", 0.92), `SnapShot-${stamp()}.jpg`));

$("#btn-pdf").addEventListener("click", () => {
  const dataUrl = flatten("image/png");
  const img = new Image();
  img.onload = () => {
    const { jsPDF } = jspdf;
    const w = img.width, h = img.height;
    const orientation = w > h ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "px", format: [w, Math.min(h, w * 1.414)] });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    // Split very tall images across multiple pages.
    const sliceH = Math.floor((pageW / w) ? pageH * (w / pageW) : pageH);
    let y = 0, first = true;
    const scale = pageW / w;
    const pageSrcH = pageH / scale;
    while (y < h) {
      if (!first) pdf.addPage([pageW, pageH], orientation);
      const c = document.createElement("canvas");
      c.width = w;
      c.height = Math.min(pageSrcH, h - y);
      c.getContext("2d").drawImage(img, 0, y, w, c.height, 0, 0, w, c.height);
      pdf.addImage(c.toDataURL("image/png"), "PNG", 0, 0, pageW, c.height * scale);
      y += pageSrcH;
      first = false;
    }
    pdf.save(`SnapShot-${stamp()}.pdf`);
    void sliceH;
  };
  img.src = dataUrl;
});

$("#btn-copy").addEventListener("click", async () => {
  try {
    const dataUrl = flatten("image/png");
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    toast("Copied to clipboard");
  } catch (e) {
    toast("Copy failed: " + e.message);
  }
});

// ---- S3 upload -------------------------------------------------------------
$("#btn-upload").addEventListener("click", () => {
  const p = $("#upload-panel");
  p.hidden = !p.hidden;
});
$("#btn-upload-go").addEventListener("click", async () => {
  const url = $("#s3-url").value.trim();
  if (!url) return toast("Paste a presigned PUT URL");
  try {
    const blob = await (await fetch(flatten("image/png"))).blob();
    const res = await fetch(url, { method: "PUT", body: blob, headers: { "Content-Type": "image/png" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const publicUrl = url.split("?")[0];
    $("#upload-result").textContent = publicUrl;
    await navigator.clipboard.writeText(publicUrl).catch(() => {});
    toast("Uploaded — link copied");
  } catch (e) {
    $("#upload-result").textContent = "Upload failed: " + e.message;
  }
});

// ---------------------------------------------------------------------------
// OCR (Tesseract.js, fully offline via vendored worker/core/lang)
// ---------------------------------------------------------------------------
let ocrWorker = null;
async function getOcrWorker() {
  if (ocrWorker) return ocrWorker;
  const base = chrome.runtime.getURL("vendor/tesseract/");
  ocrWorker = await Tesseract.createWorker("eng", 1, {
    workerPath: base + "worker.min.js",
    corePath: chrome.runtime.getURL("vendor/tesseract/"),
    langPath: base + "lang",
    gzip: true,
    logger: (m) => {
      if (m.status === "recognizing text") showProgress("OCR…", m.progress);
    },
  });
  return ocrWorker;
}

async function runOcr() {
  try {
    showProgress("Loading OCR…", 0.05);
    const worker = await getOcrWorker();
    const canvas = getBaseCanvas();
    const { data } = await worker.recognize(canvas);
    hideProgress();
    $("#ocr-panel").hidden = false;
    $("#ocr-text").value = data.text.trim();
    await navigator.clipboard.writeText(data.text.trim()).catch(() => {});
    toast("OCR done — text copied");
    return data;
  } catch (e) {
    hideProgress();
    toast("OCR failed: " + e.message);
    console.error(e);
  }
}
$("#btn-ocr").addEventListener("click", runOcr);
$("#btn-ocr-copy").addEventListener("click", () => {
  navigator.clipboard.writeText($("#ocr-text").value).then(() => toast("Text copied"));
});

// Text-only blur: OCR to get word boxes, then blur each box.
$("#prop-textblur").addEventListener("change", async (e) => {
  if (!e.target.checked) return;
  toast("Detecting text regions…");
  const data = await runOcr();
  if (!data?.words) return;
  data.words.forEach((w) => {
    if (w.confidence < 30) return;
    const b = w.bbox;
    applyBlur({ x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 });
  });
  pushUndo();
  toast("Blurred " + (data.words?.length || 0) + " text regions");
});

// ---------------------------------------------------------------------------
// QR / barcode decode
// ---------------------------------------------------------------------------
async function decodeCodes() {
  const canvas = getBaseCanvas();
  const ctx = canvas.getContext("2d");
  let value = null, format = null;

  if ("BarcodeDetector" in window) {
    try {
      const detector = new BarcodeDetector();
      const codes = await detector.detect(canvas);
      if (codes.length) { value = codes[0].rawValue; format = codes[0].format; }
    } catch (_) { /* fall through to jsQR */ }
  }
  if (!value) {
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const r = jsQR(imgData.data, imgData.width, imgData.height);
    if (r) { value = r.data; format = "qr_code"; }
  }

  $("#qr-panel").hidden = false;
  const out = $("#qr-result");
  if (value) {
    out.textContent = `[${format}] ${value}`;
    await navigator.clipboard.writeText(value).catch(() => {});
    toast("Code decoded — copied");
  } else {
    out.textContent = "No QR / barcode found.";
    toast("No code found");
  }
}
$("#btn-qr").addEventListener("click", decodeCodes);
$("#btn-qr-copy").addEventListener("click", () => {
  const v = $("#qr-result").textContent.replace(/^\[.*?\]\s*/, "");
  navigator.clipboard.writeText(v).then(() => toast("Value copied"));
});

// ---------------------------------------------------------------------------
boot();
