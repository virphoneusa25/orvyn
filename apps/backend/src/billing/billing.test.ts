import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateRunCost, NullBillingProvider } from "./BillingProvider";
import { EntitlementService } from "./EntitlementService";

test("NullBillingProvider records usage without charging", async () => {
  const p = new NullBillingProvider();
  const r = await p.meter({
    promptTokens: 10,
    completionTokens: 5,
    cachedTokens: 0,
    modelRequests: 1,
    toolRuntimeMs: 0,
    cloudWorkerMs: 0,
    sandboxMs: 0,
    storageBytes: 0,
    estimatedCostUsd: 0,
  });
  assert.equal(p.name, "none");
  assert.equal(r.ok, true);
  assert.match(String(r.detail), /charged/i);
});

test("estimateRunCost separates model tokens from execution time", () => {
  const c = estimateRunCost({ promptTokens: 1_000_000, completionTokens: 250_000, cloudWorkerMs: 3_600_000 });
  assert.ok(c.estimatedCost > 0);
  assert.equal(c.executionCost, 0.4);
});

test("EntitlementService enforces quotas", () => {
  const e = new EntitlementService({
    tokenBudget: 100,
    cloudMinutes: 10,
    storageBytes: 1000,
    concurrentMissions: 1,
    artifactStorageBytes: 100,
  });
  assert.equal(e.check({ tokenBudget: 10 }).ok, true);
  assert.equal(e.check({ tokenBudget: 101 }).ok, false);
  assert.match(e.check({ concurrentMissions: 2 }).reason ?? "", /Concurrent/);
});
