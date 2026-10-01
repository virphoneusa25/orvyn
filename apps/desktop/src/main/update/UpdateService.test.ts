import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { AutoUpdaterLike } from "./UpdateService.ts";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { UpdateService } = require(path.join(here, "../../../dist/main/update/UpdateService.js"));
const { loadUpdatePrefs } = require(path.join(here, "../../../dist/main/update/updatePrefs.js"));

class FakeUpdater extends EventEmitter implements AutoUpdaterLike {
  autoDownload = false;
  autoInstallOnAppQuit = true;
  allowDowngrade = true;
  allowPrerelease = false;
  feed: unknown;
  checks = 0;
  downloads = 0;
  installs = 0;
  setFeedURL(opts: { provider: "generic"; url: string }) {
    this.feed = opts;
  }
  async checkForUpdates() {
    this.checks += 1;
    this.emit("checking-for-update");
    this.emit("update-available", { version: "1.5.0", releaseNotes: "Faster indexing", releaseDate: "2026-10-01" });
    return {};
  }
  async downloadUpdate() {
    this.downloads += 1;
    this.emit("download-progress", { percent: 50, transferred: 10, total: 20, bytesPerSecond: 1 });
    this.emit("update-downloaded", { version: "1.5.0" });
    return {};
  }
  quitAndInstall() {
    this.installs += 1;
  }
}

test("feed 500 or 404 is a quiet miss, not a blocking error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orvyn-upd-"));
  const updater = new FakeUpdater();
  const svc = new UpdateService({
    userData: dir,
    packaged: true,
    currentVersion: "0.2.0",
    platform: "win32",
    arch: "x64",
    getBackend: async () => ({ backendUrl: "", apiKey: "" }),
    send: () => undefined,
    loadUpdater: async () => updater,
    fetchImpl: (async () => ({ ok: false, status: 500, json: async () => ({}) })) as typeof fetch,
  });
  const state = await svc.check();
  assert.equal(state.status, "not_available");
  assert.equal(updater.checks, 0);
  await rm(dir, { recursive: true, force: true });
});

test("unpackaged app stays idle and does not require the update server", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orvyn-upd-"));
  const sent: unknown[] = [];
  const svc = new UpdateService({
    userData: dir,
    packaged: false,
    currentVersion: "1.4.2",
    platform: "win32",
    arch: "x64",
    getBackend: async () => ({ backendUrl: "http://127.0.0.1:9", apiKey: "" }),
    send: (_c, p) => sent.push(p),
    loadUpdater: async () => {
      throw new Error("should not load");
    },
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
  });
  const state = await svc.check();
  assert.equal(state.status, "not_available");
  assert.equal(state.currentVersion, "1.4.2");
  await rm(dir, { recursive: true, force: true });
});

test("available → download → install-on-exit and restart protection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orvyn-upd-"));
  const updater = new FakeUpdater();
  const svc = new UpdateService({
    userData: dir,
    packaged: true,
    currentVersion: "1.4.2",
    platform: "win32",
    arch: "x64",
    getBackend: async () => ({ backendUrl: "", apiKey: "" }),
    send: () => undefined,
    loadUpdater: async () => updater,
    fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as typeof fetch,
  });
  await svc.start();
  svc.stop();
  const available = await svc.check();
  assert.equal(available.status, "available");
  assert.equal(available.availableVersion, "1.5.0");
  const dl = await svc.download();
  assert.equal(dl.status, "downloaded");
  svc.setWorkBusy(true);
  const blocked = await svc.restartAndInstall();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "mission_active");
  svc.setWorkBusy(false);
  const armed = await svc.installOnExit();
  assert.equal(armed.installOnExitArmed, true);
  const inst = await svc.restartAndInstall();
  assert.equal(inst.ok, true);
  assert.equal(updater.installs, 1);
  await rm(dir, { recursive: true, force: true });
});

test("signature failure is not installed and channel persists", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orvyn-upd-"));
  const updater = new FakeUpdater();
  updater.checkForUpdates = async () => {
    updater.emit("error", new Error("sha512 checksum mismatch"));
  };
  const svc = new UpdateService({
    userData: dir,
    packaged: true,
    currentVersion: "1.4.2",
    platform: "win32",
    arch: "x64",
    getBackend: async () => ({ backendUrl: "", apiKey: "" }),
    send: () => undefined,
    loadUpdater: async () => updater,
    fetchImpl: (async () => ({ ok: true, json: async () => ({}) })) as typeof fetch,
  });
  const failed = await svc.check();
  assert.equal(failed.status, "error");
  assert.match(failed.error ?? "", /could not be verified/i);
  const next = await svc.setChannel("beta");
  assert.equal(next.channel, "beta");
  const prefs = await loadUpdatePrefs(dir);
  assert.equal(prefs.channel, "beta");
  const bad = await svc.setChannel("nightly");
  assert.equal(prefs.channel, "beta");
  assert.equal(bad.channel, "beta");
  await rm(dir, { recursive: true, force: true });
});

test("optional update can be dismissed; required policy cannot", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "orvyn-upd-"));
  const updater = new FakeUpdater();
  const svc = new UpdateService({
    userData: dir,
    packaged: true,
    currentVersion: "1.4.2",
    platform: "win32",
    arch: "x64",
    getBackend: async () => ({ backendUrl: "https://app.example", apiKey: "t" }),
    send: () => undefined,
    loadUpdater: async () => updater,
    fetchImpl: (async () => ({
      ok: true,
      json: async () => ({ latest: "1.8.3", minimumSupported: "1.7.5", required: true, notes: "A security update is required." }),
    })) as typeof fetch,
  });
  await svc.check();
  assert.equal(svc.isCloudRestricted(), true);
  assert.equal(svc.getState().required, true);
  const after = svc.dismiss();
  assert.equal(after.required, true);
  await rm(dir, { recursive: true, force: true });
});
