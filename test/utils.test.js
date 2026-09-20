// Unit tests for the shared utilities (src/lib/utils.js).
// Run: npm test   (uses Node's built-in test runner — no dependencies)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadUtils } = require("./env.js");

const { U } = loadUtils();

// --------------------------------------------------------------------------
// Results come from the vm sandbox realm, so spread into this realm before
// a strict deep-equal (otherwise prototypes differ and the compare fails).
const rect = (r) => ({ ...r });

test("clampRect keeps a rect fully inside bounds", () => {
  assert.deepEqual(rect(U.clampRect({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)),
    { x: 10, y: 20, width: 30, height: 40 });
});

test("clampRect clamps negative origin to 0", () => {
  const r = rect(U.clampRect({ x: -5, y: -8, width: 40, height: 40 }, 100, 100));
  assert.deepEqual(r, { x: 0, y: 0, width: 40, height: 40 });
});

test("clampRect shrinks width/height that overflow bounds", () => {
  const r = rect(U.clampRect({ x: 80, y: 90, width: 50, height: 50 }, 100, 100));
  assert.deepEqual(r, { x: 80, y: 90, width: 20, height: 10 });
});

test("clampRect rounds fractional values", () => {
  const r = rect(U.clampRect({ x: 1.4, y: 2.6, width: 10.5, height: 9.5 }, 100, 100));
  assert.deepEqual(r, { x: 1, y: 3, width: 11, height: 10 });
});

// --------------------------------------------------------------------------
test("sleep resolves after roughly the given delay", async () => {
  const start = Date.now();
  await U.sleep(40);
  assert.ok(Date.now() - start >= 35, "should wait ~40ms");
});

// --------------------------------------------------------------------------
test("throttle fires immediately on the leading call", () => {
  let calls = 0;
  const fn = U.throttle(() => calls++, 50);
  fn();
  assert.equal(calls, 1);
});

test("throttle coalesces bursts and fires a trailing call", async () => {
  let calls = 0;
  const fn = U.throttle(() => calls++, 50);
  fn(); fn(); fn(); // 1 leading, rest coalesced
  assert.equal(calls, 1);
  await U.sleep(70);
  assert.equal(calls, 2, "trailing call should fire once after the window");
});

test("throttle passes the latest arguments to the trailing call", async () => {
  const seen = [];
  const fn = U.throttle((v) => seen.push(v), 40);
  fn("a"); fn("b"); fn("c");
  await U.sleep(60);
  assert.deepEqual(seen, ["a", "c"]);
});

// --------------------------------------------------------------------------
test("rafDebounce coalesces multiple calls into one frame", () => {
  const { U: u2, flushRaf, rafPending } = loadUtils();
  let calls = 0;
  const fn = u2.rafDebounce(() => calls++);
  fn(); fn(); fn();
  assert.equal(rafPending(), 1, "only one frame scheduled");
  flushRaf();
  assert.equal(calls, 1);
});

test("rafDebounce uses the most recent arguments", () => {
  const { U: u2, flushRaf } = loadUtils();
  let last = null;
  const fn = u2.rafDebounce((v) => (last = v));
  fn(1); fn(2); fn(3);
  flushRaf();
  assert.equal(last, 3);
});

test("rafDebounce reschedules after a frame flush", () => {
  const { U: u2, flushRaf, rafPending } = loadUtils();
  let calls = 0;
  const fn = u2.rafDebounce(() => calls++);
  fn(); flushRaf();
  assert.equal(calls, 1);
  fn(); assert.equal(rafPending(), 1);
  flushRaf();
  assert.equal(calls, 2);
});

// --------------------------------------------------------------------------
test("blobToDataUrl resolves to a data URL", async () => {
  const url = await U.blobToDataUrl({ type: "image/png", __text: "hi" });
  assert.ok(url.startsWith("data:image/png;base64,"));
  assert.equal(url, "data:image/png;base64," + Buffer.from("hi").toString("base64"));
});

test("blobToDataUrl rejects on read error", async () => {
  await assert.rejects(() => U.blobToDataUrl({ __fail: true }));
});

// --------------------------------------------------------------------------
test("loadImage resolves with a loaded image", async () => {
  const img = await U.loadImage("data:image/png;base64,AAAA");
  assert.equal(img.width, 100);
  assert.equal(img.height, 80);
});

test("loadImage rejects on error", async () => {
  await assert.rejects(() => U.loadImage("bad-source"));
});

// --------------------------------------------------------------------------
test("deviceProfile: high-end machine is not low-power", () => {
  const { U: u } = loadUtils({
    navigator: { hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: "4g" } },
  });
  const p = u.deviceProfile();
  assert.equal(p.lowPower, false);
  assert.equal(p.maxCanvasPx, 32000);
  assert.equal(p.maxPixelRatio, 2);
  assert.ok(p.sliceDelayMs <= 300);
});

test("deviceProfile: 2-core machine is low-power with gentler settings", () => {
  const { U: u } = loadUtils({
    navigator: { hardwareConcurrency: 2, deviceMemory: 4, connection: { effectiveType: "4g" } },
  });
  const p = u.deviceProfile();
  assert.equal(p.lowPower, true);
  assert.equal(p.maxCanvasPx, 16000);
  assert.equal(p.maxPixelRatio, 1);
  assert.ok(p.sliceDelayMs >= 400, "low-power waits longer between slices");
  assert.equal(p.ocrWorkers, 1);
});

test("deviceProfile: Save-Data / 2G forces low-power", () => {
  const { U: u } = loadUtils({
    navigator: { hardwareConcurrency: 8, deviceMemory: 8, connection: { effectiveType: "2g", saveData: true } },
  });
  const p = u.deviceProfile();
  assert.equal(p.saveData, true);
  assert.equal(p.lowPower, true);
});

test("deviceProfile: missing navigator hints fall back to sane defaults", () => {
  const { U: u } = loadUtils({ navigator: {} });
  const p = u.deviceProfile();
  assert.equal(p.cores, 4);
  assert.equal(p.memory, 4);
  assert.equal(p.lowPower, false);
  assert.ok(p.ocrWorkers >= 1);
});

test("deviceProfile: maxPixelRatio never exceeds the device ratio", () => {
  // window.devicePixelRatio is 2 in the sandbox; cap stays <= 2.
  const { U: u } = loadUtils({
    navigator: { hardwareConcurrency: 16, deviceMemory: 16, connection: { effectiveType: "4g" } },
  });
  assert.ok(u.deviceProfile().maxPixelRatio <= 2);
});
