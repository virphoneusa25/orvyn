// apps/backend/src/execution/VercelExecutionProvider.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  VercelExecutionProvider,
  reconcileDownloadedWorkspace,
  vercelSandboxName,
} from "./VercelExecutionProvider";
import { SandboxRegistry } from "./sandbox/SandboxRegistry";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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

test("persistent Vercel sandbox names are stable and workspace-scoped", () => {
  const a = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const again = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const otherTenant = vercelSandboxName({
    tenantId: "tenant-b",
    workspaceId: "workspace-1",
    projectId: "project-1",
  });
  const otherWorkspace = vercelSandboxName({
    tenantId: "tenant-a",
    workspaceId: "workspace-2",
    projectId: "project-1",
  });

  assert.equal(a, again);
  assert.notEqual(a, otherTenant);
  assert.notEqual(a, otherWorkspace);
  assert.match(a, /^orvyn-ws-[a-f0-9]{24}$/);
  assert.equal(a.includes("tenant-a"), false);
  assert.equal(a.includes("workspace-1"), false);
});

test("Vercel cloud provider fails closed when server credentials are absent", async () => {
  await withCleanEnv(async () => {
    const provider = new VercelExecutionProvider();
    const health = await provider.health();
    assert.equal(health.healthy, false);
    assert.match(health.detail ?? "", /auth|credentials/i);
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


test("Vercel workspace sync-back preserves edits, adds files, and applies deletions", async () => {
  const project = mkdtempSync(join(tmpdir(), "orvyn-vercel-project-"));
  const extracted = mkdtempSync(join(tmpdir(), "orvyn-vercel-extracted-"));
  try {
    mkdirSync(join(project, "src"), { recursive: true });
    mkdirSync(join(project, "nested", "remove-me"), { recursive: true });
    mkdirSync(join(project, ".git"), { recursive: true });
    writeFileSync(join(project, "src", "keep.txt"), "old\n");
    writeFileSync(join(project, "delete.txt"), "delete me\n");
    writeFileSync(join(project, "nested", "remove-me", "old.txt"), "gone\n");
    writeFileSync(join(project, ".git", "config"), "preserve git metadata\n");

    mkdirSync(join(extracted, "src"), { recursive: true });
    writeFileSync(join(extracted, "src", "keep.txt"), "new\n");
    writeFileSync(join(extracted, "created.txt"), "created\n");

    const files = await reconcileDownloadedWorkspace(project, extracted);

    assert.equal(readFileSync(join(project, "src", "keep.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(project, "created.txt"), "utf8"), "created\n");
    assert.equal(existsSync(join(project, "delete.txt")), false);
    assert.equal(existsSync(join(project, "nested", "remove-me", "old.txt")), false);
    assert.equal(existsSync(join(project, "nested", "remove-me")), false);
    assert.equal(
      readFileSync(join(project, ".git", "config"), "utf8"),
      "preserve git metadata\n"
    );
    assert.deepEqual(files.sort(), ["created.txt", "src/keep.txt"]);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(extracted, { recursive: true, force: true });
  }
});
