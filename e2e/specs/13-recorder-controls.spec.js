// Exhaustive coverage of Loom-style recorder controls + popup recording prefs.
const { test, expect } = require("../fixtures.js");

async function openStudio(context, extensionId, qs = "cam=0&mic=0&audio=0&saveAs=0&fake=1") {
  const rec = await context.newPage();
  await rec.goto(`chrome-extension://${extensionId}/src/recorder/recorder.html?${qs}`);
  return rec;
}

async function goLive(rec) {
  await rec.click("#btn-start");
  await expect(rec.locator("#live-chip")).toBeVisible({ timeout: 15_000 });
  await expect(rec.locator("#actions-live")).toBeVisible();
}

test.describe("Recorder controls (exhaustive)", () => {
  test("ready UI shows share + start, hides live toolbar", async ({ context, extensionId }) => {
    const rec = await openStudio(context, extensionId);
    await expect(rec.locator("#actions-ready")).toBeVisible();
    await expect(rec.locator("#btn-start")).toBeVisible();
    await expect(rec.locator("#btn-share")).toBeVisible();
    await expect(rec.locator("#actions-live")).toBeHidden();
    await expect(rec.locator("#live-chip")).toBeHidden();
    await expect(rec.locator("#status-label")).toHaveText(/Ready/i);
  });

  test("countdown cancel aborts before MediaRecorder starts", async ({ context, extensionId }) => {
    test.setTimeout(30_000);
    const rec = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0");
    await rec.click("#btn-start");
    await expect(rec.locator("#countdown")).toBeVisible({ timeout: 5_000 });
    await rec.click("#btn-cancel-count");
    await expect(rec.locator("#countdown")).toBeHidden({ timeout: 5_000 });
    await expect(rec.locator("#live-chip")).toBeHidden();
    const started = await rec.evaluate(() => !!window.__recorder.state.startedAt);
    expect(started).toBe(false);
  });

  test("pause freezes MediaRecorder and clock; resume continues", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);

    await rec.click("#btn-pause");
    await expect(rec.locator("#paused-banner")).toBeVisible();
    await expect(rec.locator("#btn-pause")).toHaveClass(/is-paused/);
    await expect(rec.locator("#status-label")).toHaveText(/Paused/i);

    const paused = await rec.evaluate(() => ({
      flag: window.__recorder.state.paused,
      recState: window.__recorder.state.recorder?.state,
      clock: document.getElementById("rec-clock").textContent,
    }));
    expect(paused.flag).toBe(true);
    expect(paused.recState).toBe("paused");

    await rec.waitForTimeout(1200);
    const clockLater = await rec.locator("#rec-clock").textContent();
    expect(clockLater).toBe(paused.clock);

    await rec.click("#btn-pause");
    await expect(rec.locator("#paused-banner")).toBeHidden();
    const resumed = await rec.evaluate(() => ({
      flag: window.__recorder.state.paused,
      recState: window.__recorder.state.recorder?.state,
    }));
    expect(resumed.flag).toBe(false);
    expect(resumed.recState).toBe("recording");
  });

  test("Save downloads a WebM; Discard does not", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);
    await rec.waitForTimeout(800);

    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 30_000 }),
      rec.click("#btn-stop"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/i);

    const rec2 = await openStudio(context, extensionId);
    await goLive(rec2);
    await rec2.waitForTimeout(400);
    const dl = rec2.waitForEvent("download", { timeout: 3_500 }).then(
      () => "downloaded",
      () => "none"
    );
    await rec2.click("#btn-discard");
    await expect(rec2.locator("#saving")).toBeVisible({ timeout: 5_000 });
    expect(await dl).toBe("none");
  });

  test("quality presets map to canvas size (720 / 1080 / 1440)", async ({ context, extensionId }) => {
    test.setTimeout(90_000);
    const cases = [
      { q: "720", w: 1280, h: 720 },
      { q: "1080", w: 1920, h: 1080 },
      { q: "1440", w: 2560, h: 1440 },
    ];
    for (const c of cases) {
      const rec = await openStudio(
        context,
        extensionId,
        `cam=0&mic=0&audio=0&saveAs=0&fake=1&q=${c.q}`
      );
      await goLive(rec);
      const size = await rec.evaluate(() => {
        const canvas = window.__recorder.state.canvas;
        return { w: canvas.width, h: canvas.height, q: window.__recorder.opts.quality };
      });
      expect(size).toEqual({ w: c.w, h: c.h, q: c.q });
      await rec.close();
    }
  });

  test("PiP corner cycles bc → br → bl → bc", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0&fake=1&pip=bc");
    await goLive(rec);
    await rec.evaluate(() => window.__recorder._armCam());
    await expect(rec.locator("#btn-pip-pos")).toBeVisible();

    const order = [];
    for (let i = 0; i < 3; i++) {
      await rec.click("#btn-pip-pos");
      order.push(await rec.evaluate(() => window.__recorder.state.pip));
    }
    expect(order).toEqual(["br", "bl", "bc"]);
    await expect(rec.locator("#person-panel")).toHaveClass(/pip--bc/);
  });

  test("mic mute toggles track.enabled and button state", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);
    await rec.evaluate(() => window.__recorder._armMic());
    await expect(rec.locator("#btn-mic")).toBeVisible();

    await rec.click("#btn-mic");
    await expect(rec.locator("#btn-mic")).toHaveClass(/is-off/);
    const muted = await rec.evaluate(() => ({
      muted: window.__recorder.state.micMuted,
      enabled: window.__recorder.state.mic._track.enabled,
    }));
    expect(muted).toEqual({ muted: true, enabled: false });

    await rec.click("#btn-mic");
    await expect(rec.locator("#btn-mic")).not.toHaveClass(/is-off/);
    const unmuted = await rec.evaluate(() => ({
      muted: window.__recorder.state.micMuted,
      enabled: window.__recorder.state.mic._track.enabled,
    }));
    expect(unmuted).toEqual({ muted: false, enabled: true });
  });

  test("camera hide toggles track, panel, and pip/blur buttons", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);
    await rec.evaluate(() => window.__recorder._armCam());
    await expect(rec.locator("#btn-cam")).toBeVisible();
    await expect(rec.locator("#btn-pip-pos")).toBeVisible();
    await expect(rec.locator("#btn-blur")).toBeVisible();

    await rec.click("#btn-cam");
    await expect(rec.locator("#btn-cam")).toHaveClass(/is-off/);
    await expect(rec.locator("#person-panel")).toBeHidden();
    await expect(rec.locator("#btn-pip-pos")).toBeHidden();
    await expect(rec.locator("#btn-blur")).toBeHidden();
    const off = await rec.evaluate(() => ({
      camOff: window.__recorder.state.camOff,
      enabled: window.__recorder.state.camera._track.enabled,
    }));
    expect(off).toEqual({ camOff: true, enabled: false });

    await rec.click("#btn-cam");
    await expect(rec.locator("#btn-cam")).not.toHaveClass(/is-off/);
    await expect(rec.locator("#person-panel")).toBeVisible();
    await expect(rec.locator("#btn-pip-pos")).toBeVisible();
  });

  test("blur starts from URL, toggles button + state, composites when camera armed", async ({
    context,
    extensionId,
  }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(
      context,
      extensionId,
      "cam=0&mic=0&audio=0&saveAs=0&fake=1&blur=1"
    );
    expect(await rec.evaluate(() => window.__recorder.state.blurBg)).toBe(true);
    await goLive(rec);
    await rec.evaluate(() => window.__recorder._armCam());
    await expect(rec.locator("#btn-blur")).toBeVisible();
    await expect(rec.locator("#btn-blur")).toHaveClass(/is-on/);
    await expect(rec.locator("#person-panel")).toHaveClass(/is-blur/);

    await rec.click("#btn-blur");
    await expect(rec.locator("#btn-blur")).not.toHaveClass(/is-on/);
    expect(await rec.evaluate(() => window.__recorder.state.blurBg)).toBe(false);
    await expect(rec.locator("#person-panel")).not.toHaveClass(/is-blur/);

    await rec.click("#btn-blur");
    expect(await rec.evaluate(() => window.__recorder.state.blurBg)).toBe(true);
  });

  test("share mid-record marks preview live; change label updates", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);
    await expect(rec.locator("#share-label-live")).toHaveText("Share");
    await rec.click("#btn-share-live");
    await expect(rec.locator("#screen-preview")).toHaveClass(/is-live/, { timeout: 20_000 });
    await expect(rec.locator("#share-label-live")).toHaveText("Change");
    const sharing = await rec.evaluate(() => window.__recorder.state.sharing);
    expect(sharing).toBe(true);
  });

  test("RECORDER_STOP from the service worker saves like the Save button", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);
    await rec.waitForTimeout(500);
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 30_000 }),
      worker.evaluate(() => chrome.runtime.sendMessage({ type: "RECORDER_STOP" })),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/i);
  });
});

test.describe("Popup recording prefs", () => {
  test("quality + blur prefs persist in chrome.storage.local", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);

    await page.locator("#rec-cam").check();
    await page.locator("#rec-mic").check();
    await page.locator("#rec-blur").check();
    await page.locator("#rec-quality").selectOption("1080");
    await page.waitForTimeout(200);

    const stored = await page.evaluate(async () => {
      const { recPrefs } = await chrome.storage.local.get("recPrefs");
      return recPrefs;
    });
    expect(stored.camera).toBe(true);
    expect(stored.mic).toBe(true);
    expect(stored.blur).toBe(true);
    expect(stored.quality).toBe("1080");

    await page.reload();
    await expect(page.locator("#rec-cam")).toBeChecked();
    await expect(page.locator("#rec-mic")).toBeChecked();
    await expect(page.locator("#rec-blur")).toBeChecked();
    await expect(page.locator("#rec-quality")).toHaveValue("1080");
  });

  test("manifest declares Ctrl/Cmd+Shift+R for toggle-recording", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/manifest.json`);
    const text = await page.locator("body").innerText();
    const manifest = JSON.parse(text);
    expect(manifest.commands["toggle-recording"].suggested_key.default).toBe("Ctrl+Shift+R");
    expect(manifest.commands["toggle-recording"].suggested_key.mac).toBe("Command+Shift+R");
  });

  test("annotate dock: pen stroke lands on compositor; clear removes it", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);

    await expect(rec.locator("#btn-annotate")).toBeVisible();
    await rec.click("#btn-annotate");
    await expect(rec.locator("#annotate-dock")).toBeVisible();
    await expect(rec.locator("#ink-pen")).toBeVisible();

    await rec.click("#ink-pen");
    await expect(rec.locator("#ink-pen")).toHaveClass(/is-active/);
    await expect(rec.locator("#ink-hit")).toBeVisible();

    // Bright red diagonal in compositor space (720p canvas).
    const sample = await rec.evaluate(() => {
      const R = window.__recorder;
      R.setInkColor("#ef4444");
      R.setInkTool("pen");
      R._addInkStroke({
        tool: "pen",
        color: "#ef4444",
        width: 12,
        opacity: 1,
        points: [200, 200, 400, 200, 600, 200],
      });
      R._paintNow();
      const c = R.state.canvas;
      const ctx = c.getContext("2d");
      // Sample mid-stroke
      const mid = ctx.getImageData(400, 200, 1, 1).data;
      // Sample far from stroke (waiting screen is dark)
      const far = ctx.getImageData(50, 50, 1, 1).data;
      return {
        strokes: R.state.inkStrokes.length,
        mid: [mid[0], mid[1], mid[2]],
        far: [far[0], far[1], far[2]],
      };
    });
    expect(sample.strokes).toBe(1);
    // Red channel should dominate near the stroke
    expect(sample.mid[0]).toBeGreaterThan(150);
    expect(sample.mid[0]).toBeGreaterThan(sample.mid[1]);
    expect(sample.mid[0]).toBeGreaterThan(sample.mid[2]);

    await rec.click("#ink-clear");
    const cleared = await rec.evaluate(() => {
      const R = window.__recorder;
      R._paintNow();
      const mid = R.state.canvas.getContext("2d").getImageData(400, 200, 1, 1).data;
      return {
        strokes: R.state.inkStrokes.length,
        mid: [mid[0], mid[1], mid[2]],
      };
    });
    expect(cleared.strokes).toBe(0);
    expect(cleared.mid[0]).toBeLessThan(80);

    await rec.keyboard.press("Escape");
    await expect(rec.locator("#annotate-dock")).toBeHidden();
    await expect(rec.locator("#ink-hit")).toBeHidden();
  });

  test("annotate: no drawing while paused; Esc leaves draw mode", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);

    await rec.click("#btn-annotate");
    await rec.click("#ink-marker");
    await expect(rec.locator("#ink-hit")).toBeVisible();

    await rec.click("#btn-pause");
    await expect(rec.locator("#paused-banner")).toBeVisible();
    await expect(rec.locator("#ink-hit")).toBeHidden();

    await rec.click("#btn-pause");
    await expect(rec.locator("#ink-hit")).toBeVisible();

    await rec.click("#ink-done");
    await expect(rec.locator("#annotate-dock")).toBeHidden();
    const tool = await rec.evaluate(() => window.__recorder.state.inkTool);
    expect(tool).toBeNull();
  });

  test("click ripple and key badge paint into compositor; toggle clears cues", async ({ context, extensionId }) => {
    test.setTimeout(45_000);
    const rec = await openStudio(context, extensionId);
    await goLive(rec);

    await expect(rec.locator("#btn-cues")).toBeVisible();
    await expect(rec.locator("#btn-cues")).toHaveClass(/is-on/);

    const withCues = await rec.evaluate(() => {
      const R = window.__recorder;
      R.state.cuesOn = true;
      R.spawnRipple(400, 300);
      R.spawnBadge("Ctrl+S");
      R._paintNow();
      const ctx = R.state.canvas.getContext("2d");
      const near = ctx.getImageData(400, 300, 1, 1).data;
      // Badge sits near bottom-center of 1280×720
      const badge = ctx.getImageData(640, 638, 1, 1).data;
      return {
        ripples: R.state.ripples.length,
        badges: R.state.keyBadges.length,
        near: [near[0], near[1], near[2]],
        badge: [badge[0], badge[1], badge[2]],
      };
    });
    expect(withCues.ripples).toBeGreaterThan(0);
    expect(withCues.badges).toBe(1);
    // Ripple center fill is indigo-ish or bright vs dark waiting bg
    expect(withCues.near[0] + withCues.near[1] + withCues.near[2]).toBeGreaterThan(40);
    // Badge panel is dark gray with light text region around it — sample should not be pure black
    expect(withCues.badge[0] + withCues.badge[1] + withCues.badge[2]).toBeGreaterThan(20);

    await rec.click("#btn-cues");
    await expect(rec.locator("#btn-cues")).not.toHaveClass(/is-on/);
    const off = await rec.evaluate(() => {
      const R = window.__recorder;
      R.spawnRipple(400, 300);
      R.spawnBadge("Esc");
      R._paintNow();
      return {
        cuesOn: R.state.cuesOn,
        ripples: R.state.ripples.length,
        badges: R.state.keyBadges.length,
      };
    });
    expect(off.cuesOn).toBe(false);
    expect(off.ripples).toBe(0);
    expect(off.badges).toBe(0);
  });

  test("popup persists click & key cues preference", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator("#rec-cues").uncheck();
    await page.waitForTimeout(200);
    const stored = await page.evaluate(async () => {
      const { recPrefs } = await chrome.storage.local.get("recPrefs");
      return recPrefs;
    });
    expect(stored.cues).toBe(false);
    await page.reload();
    await expect(page.locator("#rec-cues")).not.toBeChecked();
  });

  test("trim review: Save trimmed shortens the WebM; fake mode skips UI", async ({ context, extensionId }) => {
    test.setTimeout(120_000);

    // fake=1 defaults to skipping trim (existing Save path).
    const skip = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0&fake=1");
    await goLive(skip);
    await skip.waitForTimeout(600);
    const [dlSkip] = await Promise.all([
      skip.waitForEvent("download", { timeout: 30_000 }),
      skip.click("#btn-stop"),
    ]);
    expect(dlSkip.suggestedFilename()).toMatch(/\.webm$/i);
    await expect(skip.locator("#trim-panel")).toBeHidden();
    await skip.close().catch(() => {});

    // Force trim UI with trim=1
    const rec = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0&fake=1&trim=1");
    await goLive(rec);
    await rec.waitForTimeout(4500);
    await rec.click("#btn-stop");
    await expect(rec.locator("#trim-panel")).toBeVisible({ timeout: 15_000 });
    await expect(rec.locator("#trim-video")).toBeVisible();

    const fullDur = await rec.evaluate(async () => {
      const v = document.getElementById("trim-video");
      // Same MediaRecorder duration fix used by the trim UI
      if (!(Number.isFinite(v.duration) && v.duration > 0)) {
        await new Promise((res) => {
          const done = () => { v.removeEventListener("timeupdate", done); res(); };
          v.addEventListener("timeupdate", done);
          try { v.currentTime = 1e101; } catch (_) { res(); }
          setTimeout(res, 2000);
        });
        try { v.currentTime = 0; } catch (_) { /* ignore */ }
      }
      return v.duration;
    });
    expect(Number.isFinite(fullDur)).toBe(true);
    expect(fullDur).toBeGreaterThan(1);

    // Keep roughly the middle ~40% of the clip.
    const range = await rec.evaluate(() => {
      document.getElementById("trim-start").value = "300";
      document.getElementById("trim-end").value = "700";
      document.getElementById("trim-start").dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("trim-end").dispatchEvent(new Event("input", { bubbles: true }));
      return window.__recorder.getTrimRange();
    });
    expect(range.end - range.start).toBeGreaterThan(fullDur * 0.25);
    expect(range.end - range.start).toBeLessThan(fullDur * 0.55);

    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 90_000 }),
      rec.click("#trim-save"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/i);
    const file = await download.path();
    const buf = require("node:fs").readFileSync(file);

    const trimmedDur = await rec.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.muted = true;
      v.src = url;
      await new Promise((res, rej) => {
        v.onloadedmetadata = () => res();
        v.onerror = () => rej(new Error("metadata failed"));
      });
      if (!(Number.isFinite(v.duration) && v.duration > 0)) {
        await new Promise((res) => {
          const done = () => { v.removeEventListener("timeupdate", done); res(); };
          v.addEventListener("timeupdate", done);
          try { v.currentTime = 1e101; } catch (_) { res(); }
          setTimeout(res, 2000);
        });
      }
      const d = v.duration;
      URL.revokeObjectURL(url);
      return d;
    }, [...buf]);

    const want = range.end - range.start;
    expect(trimmedDur).toBeGreaterThan(0.3);
    // Wall-clock re-encode should track the selected window (± slack for
    // MediaRecorder keyframe / WebM duration quirks), and stay well under full.
    expect(trimmedDur).toBeLessThan(want * 1.6 + 0.4);
    expect(trimmedDur).toBeLessThan(fullDur * 0.7);
  });

  test("popup persists Export as MP4 preference", async ({ context, extensionId }) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await page.locator("#rec-mp4").check();
    await page.waitForTimeout(200);
    const stored = await page.evaluate(async () => {
      const { recPrefs } = await chrome.storage.local.get("recPrefs");
      return recPrefs;
    });
    expect(stored.mp4).toBe(true);
    await page.reload();
    await expect(page.locator("#rec-mp4")).toBeChecked();
    await page.locator("#rec-mp4").uncheck();
    await page.waitForTimeout(200);
  });

  test("default WebM save never loads ffmpeg assets", async ({ context, extensionId }) => {
    test.setTimeout(60_000);
    const rec = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0&fake=1&mp4=0");
    await goLive(rec);
    await rec.waitForTimeout(800);
    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 30_000 }),
      rec.click("#btn-stop"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.webm$/i);
    const loaded = await rec.evaluate(() => ({
      ffmpeg: !!window.__recorder.state.ffmpegLoaded,
      scripts: [...document.querySelectorAll("script[data-ffmpeg-src]")].map((s) => s.src),
      umd: !!window.FFmpegWASM,
    }));
    expect(loaded.ffmpeg).toBe(false);
    expect(loaded.scripts).toEqual([]);
    expect(loaded.umd).toBe(false);
  });

  test("mp4=1 Save downloads a playable MP4 via ffmpeg.wasm", async ({ context, extensionId }) => {
    test.setTimeout(240_000);
    const rec = await openStudio(context, extensionId, "cam=0&mic=0&audio=0&saveAs=0&fake=1&mp4=1");
    await goLive(rec);
    await rec.waitForTimeout(1200);
    const [download] = await Promise.all([
      rec.waitForEvent("download", { timeout: 180_000 }),
      rec.click("#btn-stop"),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.mp4$/i);
    const file = await download.path();
    const buf = require("node:fs").readFileSync(file);
    expect(buf.byteLength).toBeGreaterThan(500);
    // ISO BMFF "ftyp" box near the start.
    const head = buf.subarray(0, 64).toString("ascii");
    expect(head.includes("ftyp")).toBe(true);

    const probe = await rec.evaluate(async (bytes) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: "video/mp4" });
      const url = URL.createObjectURL(blob);
      const v = document.createElement("video");
      v.muted = true;
      v.preload = "metadata";
      v.src = url;
      const ok = await new Promise((res) => {
        v.onloadedmetadata = () => res(true);
        v.onerror = () => res(false);
        setTimeout(() => res(Number.isFinite(v.duration)), 8000);
      });
      const dur = v.duration;
      URL.revokeObjectURL(url);
      return { ok, dur, ffmpeg: !!window.__recorder.state.ffmpegLoaded };
    }, [...buf]);
    expect(probe.ffmpeg).toBe(true);
    expect(probe.ok).toBe(true);
    expect(probe.dur).toBeGreaterThan(0.2);
  });
});
