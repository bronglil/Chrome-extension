#!/usr/bin/env node
// Guards that manifest.json and package.json report the same version, so a
// release tag always matches what users load. Run in CI and before tagging.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const man = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

if (pkg.version !== man.version) {
  console.error(
    `✖ Version mismatch: package.json is ${pkg.version} but manifest.json is ${man.version}.\n` +
    `  Update both (npm run version:sync) before committing.`
  );
  process.exit(1);
}
console.log(`✓ Versions match: ${pkg.version}`);
