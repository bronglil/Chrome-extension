// Last-5 text copies. Auto-saves on copy/cut; Ctrl/Cmd+Shift+V opens a picker to paste.
(() => {
  if (window.__snapshotClipHist) return;
  window.__snapshotClipHist = true;

  const KEY = "clipHistory";
  const HOST_ID = "snapshot-clip-host";
  const TOP = window === window.top;
  let pickerAt = 0;
  let onKey = null;
  let lastFocus = null;
  let lastRemembered = "";
  let lastRememberedAt = 0;

  async function remember(text) {
    const t = String(text || "").replace(/\u00a0/g, " ").trim();
    if (!t) return;
    if (t === lastRemembered && Date.now() - lastRememberedAt < 400) return;
    lastRemembered = t;
    lastRememberedAt = Date.now();
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
      const res = await chrome.runtime.sendMessage({ type: "GET_CLIP_HISTORY" });
      if (Array.isArray(res?.items)) return res.items;
    } catch (_) { /* ignore */ }
    try {
      const { clipHistory } = await chrome.storage.session.get(KEY);
      if (Array.isArray(clipHistory)) return clipHistory;
    } catch (_) { /* content scripts need session access-level */ }
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
    try {
      return (window.getSelection && window.getSelection().toString()) || "";
    } catch (_) {
      return "";
    }
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = String(el.type || "text").toLowerCase();
      return /^(text|search|url|email|tel|number|password|date|datetime-local|month|week|time)$/.test(type)
        || !el.type;
    }
    return false;
  }

  function insertAtFocus(text) {
    const el = (lastFocus && document.contains(lastFocus) && isEditable(lastFocus))
      ? lastFocus
      : (isEditable(document.activeElement) ? document.activeElement : null);

    if (el) {
      try { el.focus(); } catch (_) { /* ignore */ }
      if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
        if (String(el.type || "").toLowerCase() === "password") return false;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        if (typeof el.setRangeText === "function") {
          el.setRangeText(text, start, end, "end");
        } else {
          const v = String(el.value || "");
          el.value = v.slice(0, start) + text + v.slice(end);
          const pos = start + text.length;
          try { el.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
        }
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (el.isContentEditable) {
        if (document.execCommand("insertText", false, text)) return true;
      }
    }

    if (document.execCommand("insertText", false, text)) return true;

    // Last resort: drop into a temporary textarea and leave it on the clipboard.
    try {
      navigator.clipboard.writeText(text);
    } catch (_) { /* ignore */ }
    return false;
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
    if (Date.now() - pickerAt < 250) return;
    pickerAt = Date.now();
    lastFocus = document.activeElement;
    hidePicker();
    const items = Array.isArray(passedItems) && passedItems.length
      ? passedItems
      : await list();
    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;";
    const root = host.attachShadow({ mode: "open" });
    const rows = items.length
      ? items.map((_t, i) => `<button class="row" data-i="${i}" type="button">
          <span class="n">${i + 1}</span>
          <span class="t"></span>
        </button>`).join("")
      : `<p class="empty">No copies yet. Select text and press Ctrl/⌘+C, then try again.</p>`;

    root.innerHTML = `
      <style>
        .mask { position:fixed;inset:0;background:rgba(0,0,0,.28); }
        .card {
          position:fixed;left:50%;top:16%;transform:translateX(-50%);
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
        <div class="sub">Click one to paste · press 1–5 · Esc to close</div>
        ${rows}
      </div>
    `;
    root.querySelectorAll(".row").forEach((btn, i) => {
      btn.querySelector(".t").textContent = items[i].replace(/\s+/g, " ").slice(0, 140);
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        pasteItem(items[i]);
      });
    });
    root.querySelector(".mask").addEventListener("click", hidePicker);

    onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        hidePicker();
        return;
      }
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= items.length) {
        e.preventDefault();
        e.stopPropagation();
        pasteItem(items[n - 1]);
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.documentElement.appendChild(host);
    const first = root.querySelector(".row");
    if (first) {
      try { first.focus(); } catch (_) { /* ignore */ }
    }
  }

  function onCopyLike(e) {
    const el = document.activeElement;
    if (el && String(el.type || "").toLowerCase() === "password") return;
    let text = "";
    try {
      text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    } catch (_) { /* ignore */ }
    text = text || selectedText();
    if (text) {
      remember(text);
      return;
    }
    // Button/"Copy" actions often write the clipboard without a selection.
    setTimeout(() => {
      navigator.clipboard.readText()
        .then((clip) => { if (clip) remember(clip); })
        .catch(() => {});
    }, 40);
  }

  document.addEventListener("copy", onCopyLike, true);
  document.addEventListener("cut", onCopyLike, true);

  // Capture Ctrl/Cmd+C even when the site swallows the copy event.
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.shiftKey || e.altKey) return;
    if (e.key !== "c" && e.key !== "C" && e.key !== "x" && e.key !== "X") return;
    const el = document.activeElement;
    if (el && String(el.type || "").toLowerCase() === "password") return;
    const sel = selectedText();
    if (sel) remember(sel);
    else {
      setTimeout(() => {
        navigator.clipboard.readText()
          .then((clip) => { if (clip) remember(clip); })
          .catch(() => {});
      }, 60);
    }
  }, true);

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
      showPicker(msg.items).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
      return true;
    }
    if (msg?.type === "CLIP_REMEMBER") {
      remember(msg.text).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });
})();
