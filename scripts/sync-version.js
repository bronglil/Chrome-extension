#!/usr/bin/env node
// Copies the version from package.json into manifest.json. Run after
// `npm version <patch|minor|major>` (which bumps package.json) to keep the
// extension manifest in lock-step.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const manPath = path.join(root, "manifest.json");
const man = JSON.parse(fs.readFileSync(manPath, "utf8"));

man.version = pkg.version;
fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + "\n");
console.log(`✓ manifest.json version set to ${pkg.version}`);
