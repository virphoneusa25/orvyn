import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWorkerCredential, resolveEventTenant, resolveWorkerTenant } from "./workerTenant";

const exists = (id: string) => id === "default" || id === "user_a" || id === "user_b";

test("a user session cannot address another tenant", () => {
  const denied = resolveWorkerTenant({
    callerId: "user_a",
    requestedTenantId: "user_b",
    tenantExists: exists,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.status, 403);
});

test("a user session is bound to itself even when the body is empty", () => {
  const ok = resolveWorkerTenant({ callerId: "user_a", tenantExists: exists });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_a");
});

test("control-plane key may target an existing user tenant and not an invented one", () => {
  const ok = resolveWorkerTenant({
    callerId: "default",
    requestedTenantId: "user_b",
    tenantExists: exists,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_b");
  const missing = resolveWorkerTenant({
    callerId: "default",
    requestedTenantId: "user_missing",
    tenantExists: exists,
  });
  assert.equal(missing.ok, false);
});

test("event writes follow the job tenant, not a forged body", () => {
  const ok = resolveEventTenant({
    callerId: "default",
    jobTenantId: "user_a",
    requestedTenantId: "user_b",
    tenantExists: exists,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.equal(ok.tenantId, "user_a");
  const cross = resolveEventTenant({
    callerId: "user_b",
    jobTenantId: "user_a",
    tenantExists: exists,
  });
  assert.equal(cross.ok, false);
});

test("user sessions cannot poll as a worker", () => {
  const denied = assertWorkerCredential("user_a");
  assert.equal(denied.ok, false);
  assert.equal(assertWorkerCredential("default").ok, true);
});
