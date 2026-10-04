// apps/backend/src/queue/DistributedRedis.integration.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { TenantMissionSemaphore } from "./TenantMissionSemaphore";
import { RedisMissionQueue } from "./RedisMissionQueue";
import { RedisMissionStateStore } from "./RedisMissionStateStore";
import { WorkerHeartbeatRegistry } from "./WorkerHeartbeat";
import { MISSION_QUEUE_NAME } from "./types";

const url = process.env.ORVYN_REDIS_TEST_URL;

test(
  "real Redis: tenant leases enforce limits, release, and crash expiry",
  { skip: !url },
  async () => {
    const redis = new IORedis(url!, { maxRetriesPerRequest: 1 });
    try {
      await redis.flushdb();
      const semaphore = new TenantMissionSemaphore(redis, 2, 150);

      assert.equal(await semaphore.acquire("tenant-a", "run-1"), true);
      assert.equal(await semaphore.acquire("tenant-a", "run-2"), true);
      assert.equal(await semaphore.acquire("tenant-a", "run-3"), false);

      // A different tenant has an independent capacity pool.
      assert.equal(await semaphore.acquire("tenant-b", "run-b1"), true);

      await semaphore.release("tenant-a", "run-1");
      assert.equal(await semaphore.acquire("tenant-a", "run-3"), true);

      // Expired leases are pruned on the next acquire, simulating a worker
      // crash that never reached release().
      const oneSlot = new TenantMissionSemaphore(redis, 1, 80);
      assert.equal(await oneSlot.acquire("tenant-expiry", "dead-worker"), true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(await oneSlot.acquire("tenant-expiry", "replacement-worker"), true);
    } finally {
      await redis.quit();
    }
  }
);

test(
  "real Redis: BullMQ mission queue accepts serializable run payloads and reports waiting state",
  { skip: !url },
  async () => {
    const redis = new IORedis(url!, { maxRetriesPerRequest: 1 });
    const queue = new RedisMissionQueue(redis);
    try {
      await redis.flushdb();
      const jobId = await queue.enqueue({
        runId: "run-integration-1",
        tenantId: "tenant-integration",
        tenantName: "Integration",
        projectRoot: "/projects/integration",
        goal: "validate queue",
        requestedAt: new Date().toISOString(),
      });

      assert.equal(jobId, "run-integration-1");
      const stats = await queue.stats();
      assert.equal(stats.waiting, 1);
      assert.equal(stats.active, 0);

      assert.equal(await queue.cancelPending("run-integration-1"), true);
      const afterCancel = await queue.stats();
      assert.equal(afterCancel.waiting, 0);
      assert.equal(await queue.cancelPending("run-integration-1"), false);
    } finally {
      await queue.close();
      await redis.quit();
    }
  }
);


test(
  "real Redis: mission state follows queued -> running -> completed lifecycle",
  { skip: !url },
  async () => {
    const redis = new IORedis(url!, { maxRetriesPerRequest: 1 });
    try {
      await redis.flushdb();
      const state = new RedisMissionStateStore(redis);
      const payload = {
        runId: "run-state-1",
        tenantId: "tenant-state",
        tenantName: "State Test",
        projectRoot: "/projects/state",
        goal: "validate state",
        requestedAt: new Date().toISOString(),
      };

      await state.create(payload);
      assert.equal((await state.get(payload.runId))?.status, "queued");

      const startedAt = new Date().toISOString();
      await state.setStatus(payload.runId, "running", { workerStartedAt: startedAt });
      const running = await state.get(payload.runId);
      assert.equal(running?.status, "running");
      assert.equal(running?.workerStartedAt, startedAt);

      const completedAt = new Date().toISOString();
      await state.setStatus(payload.runId, "completed", { completedAt });
      const completed = await state.get(payload.runId);
      assert.equal(completed?.status, "completed");
      assert.equal(completed?.completedAt, completedAt);
      assert.equal(completed?.tenantId, "tenant-state");
      assert.equal(completed?.projectRoot, "/projects/state");
    } finally {
      await redis.quit();
    }
  }
);


test(
  "real Redis: worker heartbeat count drops after graceful removal and crash expiry",
  { skip: !url },
  async () => {
    const redis = new IORedis(url!, { maxRetriesPerRequest: 1 });
    try {
      await redis.flushdb();
      const registry = new WorkerHeartbeatRegistry(redis, 80);

      await registry.beat("worker-a");
      await registry.beat("worker-b");
      assert.equal(await registry.activeCount(), 2);

      await registry.remove("worker-a");
      assert.equal(await registry.activeCount(), 1);

      // Simulate worker-b disappearing without a graceful remove().
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(await registry.activeCount(), 0);
    } finally {
      await redis.quit();
    }
  }
);


test(
  "real Redis: failed BullMQ jobs are inspectable for API restart reconciliation",
  { skip: !url },
  async () => {
    const producerRedis = new IORedis(url!, { maxRetriesPerRequest: 1 });
    const workerRedis = new IORedis(url!, { maxRetriesPerRequest: null });
    const queue = new RedisMissionQueue(producerRedis);
    const worker = new Worker(
      MISSION_QUEUE_NAME,
      async () => {
        throw new Error("integration worker boom");
      },
      { connection: workerRedis }
    );

    try {
      await producerRedis.flushdb();

      await queue.enqueue({
        runId: "run-failed-inspect",
        tenantId: "tenant-failed",
        tenantName: "Failure Test",
        projectRoot: "/projects/failure",
        goal: "fail intentionally",
        requestedAt: new Date().toISOString(),
      });

      const deadline = Date.now() + 5_000;
      let inspected: Awaited<ReturnType<RedisMissionQueue["inspect"]>> = null;
      while (Date.now() < deadline) {
        inspected = await queue.inspect("run-failed-inspect");
        if (inspected?.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(inspected?.state, "failed");
      assert.match(inspected?.failedReason ?? "", /integration worker boom/);
    } finally {
      await worker.close();
      await queue.close();
      if (producerRedis.status !== "end") await producerRedis.quit().catch(() => undefined);
      if (workerRedis.status !== "end") await workerRedis.quit().catch(() => undefined);
    }
  }
);
