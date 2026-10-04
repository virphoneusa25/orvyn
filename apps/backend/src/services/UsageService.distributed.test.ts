// apps/backend/src/services/UsageService.distributed.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  QuotaExceededError,
  UsageEvent,
  UsageService,
} from "./UsageService";

class SharedUsageStore {
  events: UsageEvent[] = [];

  async saveUsageEvent(event: UsageEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  async loadRecentUsage(limit = 5000): Promise<UsageEvent[]> {
    return this.events.slice(-limit).map((event) => structuredClone(event));
  }

  async countUsageSince(ts: number): Promise<number> {
    return this.events.filter((event) => event.timestamp >= ts).length;
  }
}

async function recordOne(service: UsageService, modelId: string): Promise<void> {
  await service.record({
    modelId,
    provider: "test",
    method: "generate",
    durationMs: 1,
    ok: true,
    promptTokens: 10,
    completionTokens: 5,
  });
}

test("distributed UsageService instances refresh totals from the shared durable store", async () => {
  const store = new SharedUsageStore();
  const worker = new UsageService();
  const api = new UsageService();

  await worker.attachStore(store);
  await api.attachStore(store);

  await recordOne(worker, "worker-model");

  const totals = await api.totals();
  assert.equal(totals.requests, 1);
  assert.equal(totals.promptTokens, 10);
  assert.equal(totals.completionTokens, 5);
  assert.equal(totals.byModel["worker-model"]?.requests, 1);

  const recent = await api.recent();
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.modelId, "worker-model");
});

test("distributed quota checks recount usage written by other worker processes", async () => {
  const saved = process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "2";

  try {
    const store = new SharedUsageStore();
    const workerA = new UsageService();
    const workerB = new UsageService();

    await workerA.attachStore(store);
    await workerB.attachStore(store);

    await recordOne(workerA, "a");
    assert.equal((await workerB.quota()).used, 1);
    await workerB.checkQuota();

    await recordOne(workerA, "a");
    assert.equal((await workerB.quota()).used, 2);

    await assert.rejects(
      () => workerB.checkQuota(),
      (err: unknown) =>
        err instanceof QuotaExceededError &&
        /2\/2/.test(err.message)
    );
  } finally {
    if (saved === undefined) delete process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
    else process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = saved;
  }
});
