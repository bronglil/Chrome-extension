const $ = (s) => document.querySelector(s);
const id = new URLSearchParams(location.search).get("id");
const key = "ocr:" + id;

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 1800);
}

function render(entry) {
  if (!entry) return;
  if (entry.status === "working") {
    $("#status").textContent = "Reading the selected area…";
    $("#btn-copy").disabled = true;
    return;
  }
  if (entry.status === "error") {
    $("#status").textContent = "Could not read that area";
    $("#text").value = entry.error || "Try a clearer selection.";
    $("#btn-copy").disabled = true;
    return;
  }
  const text = entry.text || "";
  $("#text").value = text;
  $("#btn-copy").disabled = !text;
  $("#status").textContent = text ? "Text is ready — copy it below" : "No text found in that area";
  if (text) {
    navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard")).catch(() => {});
  }
}

async function boot() {
  if (!id) {
    $("#status").textContent = "Nothing to show";
    return;
  }
  const stored = (await chrome.storage.local.get(key))[key];
  render(stored);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[key]) render(changes[key].newValue);
  });
}

$("#btn-copy").addEventListener("click", () => {
  const text = $("#text").value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => toast("Copied to clipboard"));
});

boot();
