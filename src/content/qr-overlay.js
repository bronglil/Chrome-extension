// ============================================================================
// On-page QR overlay — shows a small, dismissible QR of the current page URL in
// the bottom-right corner of any site. Opt-in (off by default), toggled from the
// popup. Rendered in a Shadow DOM so page CSS can't affect it, and encoded with
// the vendored qrcode-generator (injected just before this script).
// ============================================================================
(() => {
  const HOST_ID = "snapshot-qr-host";

  function remove() {
    const el = document.getElementById(HOST_ID);
    if (el) el.remove();
  }

  function qrDataUrl(text) {
    // qrcode-generator: auto version, medium EC. createDataURL returns a GIF.
    // eslint-disable-next-line no-undef
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createDataURL(4, 8);
  }

  function render() {
    remove();
    const url = location.href;
    if (!/^https?:/i.test(url)) return; // only real web pages
    let dataUrl;
    try { dataUrl = qrDataUrl(url); } catch (_) { return; }

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:2147483647;all:initial;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .card {
          font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
          background: #fff; color: #1c2430; border: 1px solid #e6e9ef;
          border-radius: 12px; box-shadow: 0 10px 30px rgba(16,24,40,.18);
          padding: 10px; display: flex; flex-direction: column; align-items: center; gap: 6px;
        }
        @media (prefers-color-scheme: dark) {
          .card { background: #171a21; color: #e8ebf1; border-color: #262c37; }
        }
        .qr { width: 104px; height: 104px; image-rendering: pixelated; border-radius: 6px; background:#fff; padding:4px; }
        .label { font-size: 11px; opacity: .7; letter-spacing: .02em; }
        .close {
          position: absolute; top: -8px; right: -8px; width: 22px; height: 22px;
          border: none; border-radius: 50%; background: #1c2430; color: #fff;
          cursor: pointer; font-size: 13px; line-height: 22px; box-shadow: 0 2px 6px rgba(0,0,0,.3);
        }
        .wrap { position: relative; }
      </style>
      <div class="wrap">
        <button class="close" title="Hide">×</button>
        <div class="card">
          <img class="qr" alt="QR code for this page" src="${dataUrl}" />
          <span class="label">Scan to open this page</span>
        </div>
      </div>`;
    root.querySelector(".close").addEventListener("click", remove);
    document.documentElement.appendChild(host);
  }

  async function apply() {
    let enabled = false;
    try {
      const v = await chrome.storage.local.get("pageQrEnabled");
      enabled = !!v.pageQrEnabled;
    } catch (_) { /* default off */ }
    if (enabled) render(); else remove();
  }

  // React to live toggles from the popup/service worker.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "PAGE_QR_SHOW") render();
    if (msg?.type === "PAGE_QR_HIDE") remove();
  });

  apply();
})();
