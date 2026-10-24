import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWorkerCredential, resolveEventTenant, resolveWorkerTenant } from "./workerTenant";

const exists = (id: string) => id === "default" || id === "user_a" || id === "user_b";

test("a user session cannot address another tenant",  async () => {
  const denied = (await resolveWorkerTenant({
    callerId: "user_a",
    requestedTenantId: "user_b",
    tenantExists: exists,
  }));
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
});

test("a user session is bound to itself even when the body is empty",  async () => {
  const ok = (await resolveWorkerTenant({ callerId: "user_a", tenantExists: exists }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_a");
});

test("control-plane key may target an existing user tenant and not an invented one",  async () => {
  const ok = (await resolveWorkerTenant({
    callerId: "default",
    requestedTenantId: "user_b",
    tenantExists: exists,
  }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_b");
  const missing = (await resolveWorkerTenant({
    callerId: "default",
    requestedTenantId: "user_missing",
    tenantExists: exists,
  }));
  assert.equal(missing.ok, false);
});

test("event writes follow the job tenant, not a forged body",  async () => {
  const ok = (await resolveEventTenant({
    callerId: "default",
    jobTenantId: "user_a",
    requestedTenantId: "user_b",
    tenantExists: exists,
  }));
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_a");
  const cross = (await resolveEventTenant({
    callerId: "user_b",
    jobTenantId: "user_a",
    tenantExists: exists,
  }));
  assert.equal(cross.ok, false);
});

test("user sessions cannot poll as a worker", () => {
  const denied = assertWorkerCredential("user_a");
  assert.equal(denied.ok, false);
  assert.equal(assertWorkerCredential("default").ok, true);
});

test("fresh heartbeat is online; expired heartbeat is not", async () => {
  const { isWorkerOnline, countOnlineWorkers, WORKER_STALE_MS } = await import("./workerPresence");
  const now = 1_000_000;
  assert.equal(isWorkerOnline({ status: "idle", lastHeartbeat: now - 1_000 }, now), true);
  assert.equal(isWorkerOnline({ status: "idle", lastHeartbeat: now - WORKER_STALE_MS - 1 }, now), false);
  assert.equal(isWorkerOnline({ status: "offline", lastHeartbeat: now }, now), false);
  assert.equal(countOnlineWorkers([{ status: "idle", lastHeartbeat: now }, { status: "idle", lastHeartbeat: now - WORKER_STALE_MS - 5 }], now), 1);
});
