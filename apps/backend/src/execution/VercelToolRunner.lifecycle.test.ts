import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asyncOperations } from "../auth/asyncOperations";
import { RunStore } from "../agent/events";
import { VercelToolRunner } from "./VercelToolRunner";
import { VercelExecutionProvider } from "./VercelExecutionProvider";
import { SandboxRegistry } from "./sandbox/SandboxRegistry";
import type { SandboxOperations } from "./sandbox/AsyncSandboxRegistry";

const identity = {
  tenantId: "tenant-lifecycle",
  organizationId: "org-lifecycle",
  userId: "user-lifecycle",
  projectId: "project-lifecycle",
  workspaceId: "workspace-lifecycle",
};

class Provider extends VercelExecutionProvider {
  starts = 0;
  stops = 0;
  async startRun(): Promise<void> {
    this.starts++;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  sandboxId(): string { return "provider-sandbox-lifecycle"; }
  sandboxName(): string { return "orvyn-test-sandbox"; }
  isPersistent(): boolean { return false; }
  async downloadArtifacts(): Promise<{ files: string[] }> { return { files: [] }; }
  async stopRun(): Promise<void> { this.stops++; }
}

function harness(registry: SandboxOperations) {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-vercel-lifecycle-"));
  const root = join(dir, "project");
  mkdirSync(root);
  const store = new RunStore();
  const runId = `run-${Math.random().toString(16).slice(2)}`;
  store.create(runId, root, "running");
  const provider = new Provider();
  const runner = new VercelToolRunner(provider, registry);
  return { dir, root, store, runId, provider, runner };
}

function sqliteRegistry(dir: string) {
  const db = new SandboxRegistry(join(dir, "execution.sqlite"));
  return { db, ops: asyncOperations(() => db) as SandboxOperations };
}

test("async SQLite registry persists Vercel provisioning, ready, completion and audit with concurrent start/stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-registry-fixture-"));
  const { db, ops } = sqliteRegistry(dir);
  const h = harness(ops);
  try {
    await Promise.all([
      h.runner.start(h.runId, h.root, h.store, identity),
      h.runner.start(h.runId, h.root, h.store, identity),
    ]);
    assert.equal(h.provider.starts, 1, "one provider sandbox per run");
    const planned = await ops.forRun(h.runId);
    assert.equal(planned?.state, "ready");
    assert.equal(planned?.tenantId, identity.tenantId);
    assert.equal(planned?.organizationId, identity.organizationId);
    assert.equal(planned?.userId, identity.userId);
    assert.equal(planned?.workspaceId, identity.workspaceId);
    assert.equal(planned?.providerSandboxId, "provider-sandbox-lifecycle");

    await Promise.all([
      h.runner.stop(h.runId, "cancelled by user"),
      h.runner.stop(h.runId, "duplicate stop"),
    ]);
    const stopped = await ops.forRun(h.runId);
    assert.equal(stopped?.state, "stopped");
    assert.ok(stopped?.destroyedAt);
    assert.equal(h.provider.stops, 1, "provider cleanup is shared by concurrent stops");
    const audit = await ops.auditLog({ organizationId: identity.organizationId });
    assert.deepEqual(audit.map((e) => e.type).sort(), ["sandbox.destroyed", "sandbox.ready"]);
    assert.ok(audit.every((e) => e.sandboxId === planned?.id));
  } finally {
    await h.runner.stop(h.runId).catch(() => undefined);
    db.close();
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry ready-write failure cleans provisioned Vercel sandbox and retains original failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-registry-failure-"));
  const { db, ops } = sqliteRegistry(dir);
  let failReady = true;
  const failing = new Proxy(ops, {
    get(target, key, receiver) {
      if (key === "report") return async (...args: Parameters<SandboxOperations["report"]>) => {
        if (failReady && args[1].state === "ready") {
          failReady = false;
          throw new Error("synthetic ready persistence failure");
        }
        return target.report(...args);
      };
      return Reflect.get(target, key, receiver);
    },
  }) as SandboxOperations;
  const h = harness(failing);
  try {
    await assert.rejects(
      h.runner.start(h.runId, h.root, h.store, identity),
      /synthetic ready persistence failure/
    );
    assert.equal(h.provider.starts, 1);
    assert.equal(h.provider.stops, 1, "already provisioned sandbox is cleaned up");
    assert.equal(h.runner.hasRun(h.runId), false);
    const record = await ops.forRun(h.runId);
    assert.equal(record?.state, "failed");
    assert.match(record?.lastError ?? "", /synthetic ready persistence failure/);
    const audit = await ops.auditLog({ organizationId: identity.organizationId });
    assert.ok(audit.some((e) => e.type === "sandbox.failed"));
  } finally {
    await h.runner.stop(h.runId).catch(() => undefined);
    db.close();
    rmSync(h.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});
