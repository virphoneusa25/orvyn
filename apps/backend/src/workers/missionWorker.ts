// apps/backend/src/workers/missionWorker.ts
//
// Distributed BullMQ harness that re-hosts the EXISTING MultiAgentRuntime.
// ORION planning/review/tool behavior is unchanged; only process ownership
// moves from the HTTP API to this worker.

import { Worker } from "bullmq";
import { TenantManager } from "../tenancy/TenantManager";
import { registerProjectToolsFor } from "../ai/registerProjectTools";
import { createWorkerRedis } from "../queue/redisConnection";
import { MISSION_QUEUE_NAME, MissionJobPayload } from "../queue/types";
import { RedisRunEventTransport } from "../queue/RedisRunEventTransport";
import { RedisRunControlTransport } from "../queue/RedisRunControlTransport";
import { DistributedRunStore } from "../queue/DistributedRunStore";
import { DistributedRunController } from "../queue/DistributedRunController";

async function executeMission(payload: MissionJobPayload): Promise<void> {
  // Blocking reads and event publishing use dedicated Redis connections so
  // neither can stall BullMQ's own worker connection.
  const eventRedis = createWorkerRedis();
  const controlRedis = createWorkerRedis();

  const eventTransport = new RedisRunEventTransport(eventRedis);
  const controlTransport = new RedisRunControlTransport(controlRedis);
  const runStore = new DistributedRunStore(eventTransport);

  // A private TenantManager per job prevents horizontally scaled jobs from
  // sharing mutable ToolRegistry/project-root state inside one Node process.
  const manager = new TenantManager();
  const tenant = manager.create(payload.tenantName, "", payload.tenantId, { runStore });

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
    await tenant.multiAgentRuntime.executeQueuedMission(
      payload.runId,
      payload.projectRoot,
      payload.goal,
      payload.rules,
      payload.attachments
    );
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
  const concurrency = Math.max(1, Number(process.env.ORVYN_WORKER_CONCURRENCY) || 1);

  const worker = new Worker<MissionJobPayload>(
    MISSION_QUEUE_NAME,
    async (job) => executeMission(job.data),
    { connection, concurrency }
  );

  worker.on("ready", () => {
    console.log(`[mission-worker] ready; concurrency=${concurrency}`);
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
    await connection.quit();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

void main().catch((err) => {
  console.error("[mission-worker] fatal", err);
  process.exitCode = 1;
});
