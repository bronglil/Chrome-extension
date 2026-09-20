const { test, expect } = require("../fixtures.js");

test("extension loads and registers its service worker", async ({ extensionId }) => {
  expect(extensionId).toMatch(/^[a-z]{32}$/);
});
