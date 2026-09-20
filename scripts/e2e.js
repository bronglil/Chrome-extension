#!/usr/bin/env node
// Cross-platform E2E launcher. MV3 extensions need a headed browser: on Linux
// that means a virtual display (xvfb-run) when one isn't present; on macOS and
// Windows the real desktop is used, so we run Playwright directly.
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const passthrough = process.argv.slice(2);
const pwArgs = ["playwright", "test", "-c", "e2e/playwright.config.js", ...passthrough];

const isLinux = os.platform() === "linux";
const hasDisplay = !!process.env.DISPLAY;
const hasXvfb = isLinux && spawnSync("sh", ["-c", "command -v xvfb-run"]).status === 0;

let cmd, args;
if (isLinux && !hasDisplay && hasXvfb) {
  cmd = "xvfb-run"; args = ["-a", "npx", ...pwArgs];
} else {
  cmd = "npx"; args = pwArgs;
}

const res = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
process.exit(res.status == null ? 1 : res.status);
