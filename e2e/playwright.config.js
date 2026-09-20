// Playwright configuration for SnapShot Studio end-to-end tests.
// These load the REAL unpacked extension into Chromium and drive it.
const { defineConfig } = require("@playwright/test");
const path = require("node:path");

module.exports = defineConfig({
  testDir: path.join(__dirname, "specs"),
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false, // one persistent browser context at a time
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: path.join(__dirname, "report") }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
