// Last-5 text copies. Saved on any copy; picker opens with Ctrl/Cmd+Shift+V.
(() => {
  if (window.__snapshotClipHist) return;
  window.__snapshotClipHist = true;

  const KEY = "clipHistory";
  const HOST_ID = "snapshot-clip-host";
  const TOP = window === window.top;
  let pickerAt = 0;
  let onKey = null;

  async function remember(text) {
    const t = String(text || "").replace(/\u00a0/g, " ").trim();
    if (!t) return;
    const clipped = t.length > 8000 ? t.slice(0, 8000) : t;
    try {
      const res = await chrome.runtime.sendMessage({ type: "CLIP_REMEMBER", text: clipped });
      if (res?.ok) return;
    } catch (_) { /* SW asleep — write session directly */ }
    try {
      const { clipHistory } = await chrome.storage.session.get(KEY);
      const list = Array.isArray(clipHistory) ? clipHistory : [];
      const next = [clipped, ...list.filter((x) => x !== clipped)].slice(0, 5);
      await chrome.storage.session.set({ [KEY]: next });
    } catch (_) { /* session storage unavailable */ }
  }

  async function list() {
    try {
      const { clipHistory } = await chrome.storage.session.get(KEY);
      if (Array.isArray(clipHistory)) return clipHistory;
    } catch (_) { /* content scripts need session access-level */ }
    try {
      const res = await chrome.runtime.sendMessage({ type: "GET_CLIP_HISTORY" });
      if (Array.isArray(res?.items)) return res.items;
    } catch (_) { /* ignore */ }
    return [];
  }

  function selectedText() {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      if (String(el.type || "").toLowerCase() === "password") return "";
      const a = el.selectionStart;
      const b = el.selectionEnd;
      if (typeof a === "number" && typeof b === "number" && b > a) {
        return String(el.value).slice(a, b);
      }
    }
    return (window.getSelection && window.getSelection().toString()) || "";
  }

  function insertAtFocus(text) {
    const el = document.activeElement;
    if (el && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && /text|search|url|email|tel|number/.test(el.type || "text")))) {
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? start;
      el.setRangeText(text, start, end, "end");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el && el.isContentEditable) {
      document.execCommand("insertText", false, text);
      return;
    }
    document.execCommand("insertText", false, text);
  }

  function hidePicker() {
    if (onKey) {
      document.removeEventListener("keydown", onKey, true);
      onKey = null;
    }
    document.getElementById(HOST_ID)?.remove();
  }

  async function pasteItem(text) {
    hidePicker();
    try { await navigator.clipboard.writeText(text); } catch (_) { /* still insert */ }
    insertAtFocus(text);
  }

  async function showPicker(passedItems) {
    if (!TOP) return;
    if (Date.now() - pickerAt < 400) return;
    pickerAt = Date.now();
    hidePicker();
    const items = Array.isArray(passedItems) ? passedItems : await list();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const rows = items.length
      ? items.map((_t, i) => `<button class="row" data-i="${i}" type="button">
          <span class="n">${i + 1}</span>
          <span class="t"></span>
        </button>`).join("")
      : `<p class="empty">No copies yet. Copy text with Ctrl/⌘+C.</p>`;

    root.innerHTML = `
      <style>
        .mask { position:fixed;inset:0;background:rgba(0,0,0,.28); }
        .card {
          position:fixed;left:50%;top:18%;transform:translateX(-50%);
          width:min(440px,calc(100vw - 24px));
          background:#111827;color:#f3f4f6;border-radius:14px;
          box-shadow:0 18px 48px rgba(0,0,0,.4);
          font:13px/1.4 -apple-system,"Segoe UI",sans-serif;
          overflow:hidden;
        }
        .hd { padding:12px 14px 8px;font-weight:700;font-size:13px; }
        .sub { padding:0 14px 10px;color:#9ca3af;font-size:12px; }
        .row {
          display:flex;gap:10px;align-items:flex-start;width:100%;
          text-align:left;border:0;border-top:1px solid #1f2937;
          background:transparent;color:inherit;padding:10px 14px;cursor:pointer;
          font:inherit;
        }
        .row:hover,.row:focus { background:#1f2937;outline:none; }
        .n {
          flex:none;width:20px;height:20px;border-radius:6px;
          background:#4f46e5;color:#fff;display:grid;place-items:center;
          font-size:11px;font-weight:700;
        }
        .t { flex:1;word-break:break-word;max-height:3.8em;overflow:hidden; }
        .empty { margin:0;padding:16px 14px 18px;color:#9ca3af; }
      </style>
      <div class="mask"></div>
      <div class="card" role="dialog" aria-label="Last copies">
        <div class="hd">Last copies</div>
        <div class="sub">Click one to paste · 1–5 or Esc</div>
        ${rows}
      </div>
    `;
    root.querySelectorAll(".row").forEach((btn, i) => {
      btn.querySelector(".t").textContent = items[i].replace(/\s+/g, " ").slice(0, 140);
      btn.addEventListener("click", () => pasteItem(items[i]));
    });
    root.querySelector(".mask").addEventListener("click", hidePicker);

    onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); hidePicker(); }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= items.length) {
        e.preventDefault();
        pasteItem(items[n - 1]);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.documentElement.appendChild(host);
  }

  function onCopyLike(e) {
    const el = document.activeElement;
    if (el && String(el.type || "").toLowerCase() === "password") return;
    const clip = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    remember(clip || selectedText());
  }

  document.addEventListener("copy", onCopyLike, false);
  document.addEventListener("cut", onCopyLike, false);

  if (TOP) {
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        e.stopPropagation();
        showPicker();
      }
    }, true);
  }

  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === "SHOW_CLIP_PICKER") {
      showPicker(msg.items).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg?.type === "CLIP_REMEMBER") {
      remember(msg.text).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });
})();
