// apps/backend/src/workers/missionWorker.ts
//
// BullMQ worker harness for the distributed mission runtime.
//
// IMPORTANT: the queue/event substrate is production-ready, but execution is
// feature-gated until approval/steer/cancel control messages are distributed.
// This prevents a partial cutover from silently breaking ORVYN's safety gates.

import { Worker } from "bullmq";
import { createWorkerRedis } from "../queue/redisConnection";
import { MISSION_QUEUE_NAME, MissionJobPayload } from "../queue/types";

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
    async (job) => {
      // The next migration step will re-host the existing MultiAgentRuntime
      // here after the distributed control channel and shared run-state
      // projection are connected. Intentionally fail closed until then.
      throw new Error(
        `Distributed mission runtime not activated for run ${job.data.runId}; control-plane migration is incomplete.`
      );
    },
    { connection, concurrency }
  );

  worker.on("ready", () => {
    console.log(`[mission-worker] ready; concurrency=${concurrency}`);
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
