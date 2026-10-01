import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopReleaseStore } from "./desktopReleaseStore";

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-rel-"));

test("pipeline upserts a signed-channel release and pause hides it from current", () => {
  const prevLatest = process.env.ORVYN_DESKTOP_VERSION;
  const prevMin = process.env.ORVYN_DESKTOP_MINIMUM_SUPPORTED;
  delete process.env.ORVYN_DESKTOP_VERSION;
  delete process.env.ORVYN_DESKTOP_MINIMUM_SUPPORTED;
  try {
    const s = new DesktopReleaseStore(dir());
    s.upsertFromPipeline({ version: "1.4.2", channel: "stable", notes: "previous" });
    const r = s.upsertFromPipeline({
      version: "1.5.0",
      channel: "stable",
      notes: "<b>hi</b> Faster indexing",
      artifacts: [{ platform: "win32", filename: "ORVYN-Setup-1.5.0.exe", url: "https://updates.kernelailabs.com/orvyn/stable/ORVYN-Setup-1.5.0.exe" }],
    });
    assert.equal(r.notes.includes("<b>"), false);
    assert.equal(s.current("stable").latest, "1.5.0");
    s.patch(r.id, { status: "paused" });
    assert.equal(s.current("stable").latest, "1.4.2");
    s.patch(r.id, { status: "published", rolloutPercent: 10 });
    assert.equal(s.current("stable").latest, "1.5.0");
    assert.equal(s.current("stable").rolloutPercent, 10);
  } finally {
    if (prevLatest !== undefined) process.env.ORVYN_DESKTOP_VERSION = prevLatest;
    if (prevMin !== undefined) process.env.ORVYN_DESKTOP_MINIMUM_SUPPORTED = prevMin;
  }
});

test("required flag is refused without super-admin privilege", () => {
  const s = new DesktopReleaseStore(dir());
  const r = s.upsertFromPipeline({ version: "1.8.3", channel: "stable" });
  assert.throws(() => s.patch(r.id, { required: true, minimumSupportedVersion: "1.7.5" }), /super admin/);
  const next = s.patch(r.id, { required: true, minimumSupportedVersion: "1.7.5", allowRequired: true });
  assert.equal(next.required, true);
  assert.equal(s.current("stable").required, true);
});

test("invalid channel and telemetry stay privacy-safe", () => {
  const s = new DesktopReleaseStore(dir());
  assert.throws(() => s.upsertFromPipeline({ version: "1.0.0", channel: "nightly" }), /Invalid channel/);
  s.recordTelemetry({
    installationId: "inst-aaaa-bbbb",
    accountId: "acct1",
    platform: "win32",
    arch: "x64",
    version: "1.4.2",
    channel: "stable",
    event: "app_started",
  });
  s.recordTelemetry({
    installationId: "inst-aaaa-bbbb",
    accountId: "acct1",
    platform: "win32",
    arch: "x64",
    version: "1.4.2",
    channel: "stable",
    event: "not_a_real_event",
  });
  const inv = s.installationsForAccount("acct1");
  assert.equal(inv.length, 1);
  assert.equal(inv[0]?.version, "1.4.2");
  assert.equal("macAddress" in inv[0]!, false);
  const listed = s.summary().installations;
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.version, "1.4.2");
  assert.equal(listed[0]?.channel, "stable");
});

test("public downloads never include storage credentials", () => {
  const s = new DesktopReleaseStore(dir());
  s.upsertFromPipeline({ version: "1.5.0", channel: "stable", notes: "Faster indexing" });
  const d = s.publicDownloads();
  assert.equal(d.version, "1.5.0");
  assert.equal(JSON.stringify(d).includes("AKIA"), false);
  assert.equal(JSON.stringify(d).includes("secret"), false);
});
