// Test harness: loads src/lib/utils.js inside a fresh browser-like sandbox so
// the pure utilities can be unit-tested under Node without a real browser.
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src", "lib", "utils.js");
const code = fs.readFileSync(SRC, "utf8");

// Minimal browser doubles used by the utilities.
class MockFileReader {
  readAsDataURL(blob) {
    // Deterministic: encode the blob's declared text.
    Promise.resolve().then(() => {
      if (blob && blob.__fail) {
        this.onerror && this.onerror(new Error("read failed"));
      } else {
        this.result = "data:" + (blob.type || "application/octet-stream") +
          ";base64," + Buffer.from(blob.__text || "").toString("base64");
        this.onload && this.onload();
      }
    });
  }
}

class MockImage {
  set src(v) {
    this._src = v;
    Promise.resolve().then(() => {
      if (typeof v === "string" && v.startsWith("bad")) {
        this.onerror && this.onerror(new Error("load failed"));
      } else {
        this.width = 100;
        this.height = 80;
        this.onload && this.onload();
      }
    });
  }
  get src() { return this._src; }
}

// Build a sandbox and return the exported SnapShotUtils, plus timing controls.
function loadUtils({ navigator } = {}) {
  const rafQueue = [];
  const sandbox = {
    navigator: navigator || {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      connection: { effectiveType: "4g", saveData: false },
    },
    window: { devicePixelRatio: 2 },
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
    setTimeout,
    clearTimeout,
    Date,
    FileReader: MockFileReader,
    Image: MockImage,
  };
  sandbox.self = sandbox; // utils.js binds to `self`
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "utils.js" });

  return {
    U: sandbox.SnapShotUtils,
    flushRaf: () => { const q = rafQueue.splice(0); q.forEach((cb) => cb()); },
    rafPending: () => rafQueue.length,
  };
}

module.exports = { loadUtils, MockFileReader, MockImage };
