import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUpdateChannel, feedUrlForChannel, latestManifestName, updateBaseUrl, versionMatchesChannel, DEFAULT_UPDATE_BASE_URL } from "./updateChannels.ts";
import { reduceUpdate, initialUpdateState, userFacingUpdateError, publicUpdateState, sanitizeNotes, isTransientUpdateFailure } from "./updateState.ts";
import { compareSemver, requiredUpdateBlocksCloud, inStagedRollout, canPostpone, isBelowMinimum } from "./updatePolicy.ts";
import { parseBooleanArg, parseRestartArg, UPDATE_IPC, UPDATE_IPC_COMMANDS, isUpdateIpc } from "./updateIpc.ts";

test("only stable/beta/canary are valid channels", () => {
  assert.equal(parseUpdateChannel("stable"), "stable");
  assert.equal(parseUpdateChannel("BETA"), "beta");
  assert.equal(parseUpdateChannel("canary"), "canary");
  assert.equal(parseUpdateChannel("nightly"), null);
  assert.equal(parseUpdateChannel("stable; rm -rf /"), null);
  assert.equal(parseUpdateChannel({ cmd: "x" }), null);
});

test("production feed never uses localhost", () => {
  assert.equal(updateBaseUrl({}), DEFAULT_UPDATE_BASE_URL);
  assert.equal(updateBaseUrl({ ORVYN_UPDATE_BASE_URL: "http://localhost:9000/orvyn" }), DEFAULT_UPDATE_BASE_URL);
  assert.equal(feedUrlForChannel("stable"), `${DEFAULT_UPDATE_BASE_URL}/stable/`);
  assert.equal(latestManifestName("win32"), "latest.yml");
  assert.equal(latestManifestName("darwin"), "latest-mac.yml");
  assert.equal(feedUrlForChannel("beta", { ORVYN_UPDATE_BASE_URL: "https://updates.example.com/orvyn" }), "https://updates.example.com/orvyn/beta/");
});

test("stable channel rejects prerelease versions", () => {
  assert.equal(versionMatchesChannel("1.5.0", "stable"), true);
  assert.equal(versionMatchesChannel("1.5.0-canary.12", "stable"), false);
  assert.equal(versionMatchesChannel("1.5.0-beta.1", "beta"), true);
});

test("reducer: checking, available, none, progress, downloaded, error", () => {
  let s = initialUpdateState({ currentVersion: "1.4.2", channel: "stable", packaged: true });
  s = reduceUpdate(s, { type: "checking" });
  assert.equal(s.status, "checking");
  s = reduceUpdate(s, { type: "available", version: "1.5.0", notes: "<script>x</script> Faster indexing" });
  assert.equal(s.status, "available");
  assert.equal(s.availableVersion, "1.5.0");
  assert.equal(s.releaseNotes?.includes("<script>"), false);
  s = reduceUpdate(s, { type: "progress", progress: { percent: 74, transferred: 43, total: 58 } });
  assert.equal(s.status, "downloading");
  assert.equal(s.progress?.percent, 74);
  s = reduceUpdate(s, { type: "downloaded", version: "1.5.0" });
  assert.equal(s.status, "downloaded");
  s = reduceUpdate(s, { type: "error", message: "network timeout" });
  assert.equal(s.status, "error");
  s = reduceUpdate(s, { type: "not_available" });
  assert.equal(s.status, "not_available");
});

test("optional updates can be postponed; required cannot via dismiss policy", () => {
  assert.equal(canPostpone(false), true);
  assert.equal(canPostpone(true), false);
});

test("required policy blocks cloud when below minimum, not local projects", () => {
  assert.equal(requiredUpdateBlocksCloud({ currentVersion: "1.6.2", minimumSupportedVersion: "1.7.5", required: true }), true);
  assert.equal(requiredUpdateBlocksCloud({ currentVersion: "1.8.0", minimumSupportedVersion: "1.7.5", required: true }), false);
  assert.equal(requiredUpdateBlocksCloud({ currentVersion: "1.4.2", required: false }), false);
  assert.equal(isBelowMinimum("1.4.2", "1.5.0"), true);
  assert.equal(compareSemver("1.5.0", "1.5.0-beta.1") > 0, true);
});

test("user-facing errors never include stacks, paths, or secrets", () => {
  const sig = userFacingUpdateError("Error: sha512 checksum mismatch at C:\\Users\\secret\\latest.yml CSC_KEY=abc");
  assert.match(sig, /could not be verified/i);
  assert.equal(sig.includes("CSC_KEY"), false);
  assert.equal(sig.includes("C:\\"), false);
  const off = userFacingUpdateError("ENOTFOUND updates.kernelailabs.com");
  assert.match(off, /try again later/i);
  assert.equal(isTransientUpdateFailure("HTTP 500 Internal Server Error latest.yml"), true);
  assert.equal(isTransientUpdateFailure("sha512 checksum mismatch"), false);
});

test("public state sanitizes notes HTML", () => {
  const notes = sanitizeNotes("<b>hi</b>  Improved runtime");
  assert.equal(notes, "hi Improved runtime");
});

test("staged rollout is deterministic from installation id, not hardware", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const a = inStagedRollout(5, id);
  const b = inStagedRollout(5, id);
  assert.equal(a, b);
  assert.equal(inStagedRollout(0, id), false);
  assert.equal(inStagedRollout(100, id), true);
});

test("IPC surface is a closed command list", () => {
  for (const name of UPDATE_IPC_COMMANDS) assert.equal(isUpdateIpc(name), true);
  assert.equal(isUpdateIpc("shell:exec"), false);
  assert.equal(parseBooleanArg("true"), null);
  assert.equal(parseBooleanArg(true), true);
  assert.deepEqual(parseRestartArg({ force: true, cmd: "calc" }), { force: true });
  assert.deepEqual(parseRestartArg("rm -rf"), { force: false });
});

test("publicUpdateState never forwards raw exception text", () => {
  let s = initialUpdateState({ currentVersion: "1.0.0", channel: "stable", packaged: true });
  s = { ...s, error: "Error: ENOENT C:\\keys\\code.pfx password=hunter2" };
  const pub = publicUpdateState(s);
  assert.equal(pub.error?.includes("pfx"), false);
  assert.equal(pub.error?.includes("hunter2"), false);
});
