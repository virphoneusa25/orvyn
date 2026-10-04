// apps/backend/src/workers/missionWorker.ts
//
// Distributed BullMQ harness that re-hosts the EXISTING MultiAgentRuntime.
// ORION planning/review/tool behavior is unchanged; only process ownership
// moves from the HTTP API to this worker.

import { randomUUID } from "crypto";
import { DelayedError, Worker } from "bullmq";
import { TenantManager } from "../tenancy/TenantManager";
import { registerProjectToolsFor } from "../ai/registerProjectTools";
import { createWorkerRedis } from "../queue/redisConnection";
import { MISSION_QUEUE_NAME, MissionJobPayload } from "../queue/types";
import { RedisRunEventTransport } from "../queue/RedisRunEventTransport";
import { RedisRunControlTransport } from "../queue/RedisRunControlTransport";
import { DistributedRunStore } from "../queue/DistributedRunStore";
import { DistributedRunController } from "../queue/DistributedRunController";
import { TenantMissionSemaphore } from "../queue/TenantMissionSemaphore";
import { RedisMissionStateStore } from "../queue/RedisMissionStateStore";
import { WorkerHeartbeatRegistry } from "../queue/WorkerHeartbeat";

async function executeMission(payload: MissionJobPayload): Promise<void> {
  // Blocking reads and event publishing use dedicated Redis connections so
  // neither can stall BullMQ's own worker connection.
  const eventRedis = createWorkerRedis();
  const controlRedis = createWorkerRedis();

  const eventTransport = new RedisRunEventTransport(eventRedis);
  const controlTransport = new RedisRunControlTransport(controlRedis);
  const missionState = new RedisMissionStateStore(eventRedis);
  const runStore = new DistributedRunStore(eventTransport);

  // A private TenantManager per job prevents horizontally scaled jobs from
  // sharing mutable ToolRegistry/project-root state inside one Node process.
  const manager = new TenantManager();
  const tenant = await manager.create(payload.tenantName, "", payload.tenantId, {
    runStore,
    recoverDistributedRuns: false,
    distributedWorker: true,
  });

  runStore.create(payload.runId, payload.projectRoot, "queued");
  registerProjectToolsFor(tenant, payload.projectRoot);

  const controls = new DistributedRunController(
    payload.runId,
    payload.tenantId,
    tenant.multiAgentRuntime,
    runStore,
    controlTransport
  );
  const controlLoop = controls.run();

  try {
    await missionState.setStatus(payload.runId, "running", {
      workerStartedAt: new Date().toISOString(),
    });

    await tenant.multiAgentRuntime.executeQueuedMission(
      payload.runId,
      payload.projectRoot,
      payload.goal,
      payload.rules,
      payload.attachments
    );

    const terminal = runStore.get(payload.runId)?.status ?? "completed";
    await missionState.setStatus(payload.runId, terminal, {
      completedAt: new Date().toISOString(),
    });
  } catch (err: any) {
    await missionState
      .setStatus(payload.runId, "error", {
        error: err?.message ?? String(err),
        completedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    throw err;
  } finally {
    controls.stop();
    await runStore.flush();
    // Disconnecting wakes a blocked XREAD immediately. The controller catches
    // that shutdown path because stop() was set first.
    controlRedis.disconnect();
    eventRedis.disconnect();
    await Promise.race([
      controlLoop.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
}

async function main(): Promise<void> {
  if (process.env.ORVYN_DISTRIBUTED_MISSIONS?.trim() !== "1") {
    console.log("[mission-worker] distributed missions disabled; exiting cleanly");
    return;
  }

  if (process.env.ORVYN_DISTRIBUTED_CONTROLS?.trim() !== "1") {
    throw new Error(
      "Refusing distributed mission execution: ORVYN_DISTRIBUTED_CONTROLS=1 is required so approvals/steer/cancel cannot be bypassed."
    );
  }

  const connection = createWorkerRedis();
  const semaphoreRedis = createWorkerRedis();
  const heartbeatRedis = createWorkerRedis();
  const concurrency = Math.max(1, Number(process.env.ORVYN_WORKER_CONCURRENCY) || 1);
  const maxPerTenant = Math.max(1, Number(process.env.ORVYN_MAX_CONCURRENT_MISSIONS) || 2);
  // Autonomous missions are not guaranteed idempotent. BullMQ normally
  // re-processes a stalled job once; default ORVYN to fail-first-stall so a
  // crashed deployment/edit mission is never silently executed twice.
  const maxStalledCount = Math.max(
    0,
    Number(process.env.ORVYN_WORKER_MAX_STALLED_COUNT ?? "0")
  );
  const semaphore = new TenantMissionSemaphore(semaphoreRedis, maxPerTenant);
  const workerId = `worker-${randomUUID()}`;
  const heartbeat = new WorkerHeartbeatRegistry(heartbeatRedis);
  const stopHeartbeat = heartbeat.start(workerId);

  const worker = new Worker<MissionJobPayload>(
    MISSION_QUEUE_NAME,
    async (job, token) => {
      const leaseId = job.data.runId;
      const acquired = await semaphore.acquire(job.data.tenantId, leaseId);

      if (!acquired) {
        if (!token) throw new Error("BullMQ worker token unavailable while delaying tenant-limited mission");
        await job.moveToDelayed(Date.now() + 1000, token);
        throw new DelayedError();
      }

      const stopHeartbeat = semaphore.startHeartbeat(job.data.tenantId, leaseId);
      try {
        await executeMission(job.data);
      } finally {
        stopHeartbeat();
        await semaphore.release(job.data.tenantId, leaseId).catch((err) => {
          console.error(
            `[mission-worker] failed to release tenant mission slot for ${leaseId}: ${err?.message ?? err}`
          );
        });
      }
    },
    { connection, concurrency, maxStalledCount }
  );

  worker.on("ready", () => {
    console.log(
      `[mission-worker] ready; id=${workerId}; concurrency=${concurrency}; maxStalledCount=${maxStalledCount}`
    );
  });
  worker.on("completed", (job) => {
    console.log(`[mission-worker] job ${job.id} completed`);
  });
  worker.on("failed", (job, err) => {
    console.error(`[mission-worker] job ${job?.id ?? "unknown"} failed: ${err.message}`);
  });
  worker.on("error", (err) => {
    console.error("[mission-worker] worker error", err);
  });

  const shutdown = async () => {
    await worker.close();
    await stopHeartbeat();
    await connection.quit();
    await semaphoreRedis.quit();
    await heartbeatRedis.quit();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main().catch((err) => {
  console.error("[mission-worker] fatal", err);
  process.exitCode = 1;
});
