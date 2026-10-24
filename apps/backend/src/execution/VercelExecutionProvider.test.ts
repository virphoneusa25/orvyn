// apps/backend/src/execution/VercelExecutionProvider.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { VercelExecutionProvider } from "./VercelExecutionProvider";
import { SandboxRegistry } from "./sandbox/SandboxRegistry";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const KEYS = [
  "SANDBOX_VERCEL_TOKEN",
  "SANDBOX_VERCEL_TEAM_ID",
  "SANDBOX_VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
] as const;

function withCleanEnv(fn: () => Promise<void> | void): Promise<void> | void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  const restore = () => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  try {
    const result = fn();
    if (result && typeof (result as Promise<void>).then === "function") {
      return (result as Promise<void>).finally(restore);
    }
    restore();
  } catch (err) {
    restore();
    throw err;
  }
}

test("Vercel cloud provider fails closed when server credentials are absent", async () => {
  await withCleanEnv(async () => {
    const provider = new VercelExecutionProvider();
    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.match(health.detail ?? "", /credentials/i);
  });
});

test("sandbox registry records Vercel as a first-class provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-vercel-registry-"));
  try {
    const registry = new SandboxRegistry(join(dir, "execution.sqlite"));
    const rec = registry.plan({
      id: "sbx_vercel_test",
      provider: "vercel",
      organizationId: "org-test",
      tenantId: "tenant-test",
      userId: "user-test",
      projectId: "project-test",
      workspaceId: "workspace-test",
      runId: "run-test",
      policyTemplate: "code-basic",
      retention: "ephemeral",
    });
    assert.equal(rec.provider, "vercel");

    registry.report(rec.id, {
      state: "ready",
      providerSandboxId: "sbx_provider_native",
      provisionMs: 123,
    });

    const ready = registry.get(rec.id);
    assert.equal(ready?.state, "ready");
    assert.equal(ready?.providerSandboxId, "sbx_provider_native");

    const stats = registry.stats(60_000);
    assert.equal(stats.byProvider.vercel?.created, 1);
    assert.equal(stats.byProvider.vercel?.active, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
