#!/usr/bin/env node
// Fails the desktop release pipeline when version sources disagree.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
const tag = (process.env.GITHUB_REF_NAME || process.env.ORVYN_RELEASE_VERSION || "").replace(/^v/, "");
const envVersion = (process.env.ORVYN_DESKTOP_VERSION || "").trim();
const pkg = String(desktop.version || "");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg)) {
  console.error(`Invalid desktop package.json version: ${pkg}`);
  process.exit(1);
}
if (tag && tag !== pkg) {
  console.error(`Tag ${tag} does not match apps/desktop/package.json version ${pkg}`);
  process.exit(1);
}
if (envVersion && envVersion !== pkg) {
  console.error(`ORVYN_DESKTOP_VERSION ${envVersion} does not match package.json ${pkg}`);
  process.exit(1);
}
const channel = String(process.env.ORVYN_RELEASE_CHANNEL || "stable");
if (channel === "stable" && pkg.includes("-")) {
  console.error(`Stable releases cannot use a prerelease version (${pkg})`);
  process.exit(1);
}
if (channel === "beta" && pkg.includes("-") && !pkg.includes("-beta")) {
  console.error(`Beta channel version should be SemVer with -beta (${pkg})`);
  process.exit(1);
}
console.log(`Desktop version OK ${pkg} channel=${channel}`);
