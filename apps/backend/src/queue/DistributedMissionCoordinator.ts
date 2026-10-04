// apps/backend/src/queue/DistributedMissionCoordinator.ts
//
// API-side distributed mission coordinator.
//
// Responsibilities:
// - enqueue serializable mission payloads to BullMQ
// - start a Redis Streams -> RunStore bridge per distributed run
// - publish cancel / steer / approval controls
//
// It deliberately does NOT contain ORION logic or execute tools.

import { QueueEvents } from "bullmq";
import type { RunStore, Run } from "../agent/events";
import { createProducerRedis, createWorkerRedis } from "./redisConnection";
import { RedisMissionQueue } from "./RedisMissionQueue";
import { RedisRunEventTransport } from "./RedisRunEventTransport";
import { RedisRunEventBridge } from "./RedisRunEventBridge";
import { RedisRunControlTransport } from "./RedisRunControlTransport";
import { RunControlPublisher } from "./RunControlPublisher";
import { MISSION_QUEUE_NAME, type MissionJobPayload } from "./types";
import type { ApprovalScope } from "./controlTypes";

interface ActiveBridge {
  bridge: RedisRunEventBridge;
  redis: ReturnType<typeof createWorkerRedis>;
  task: Promise<void>;
  store: RunStore;
}

export class DistributedMissionCoordinator {
  private readonly producerRedis = createProducerRedis();
  private readonly controlRedis = createProducerRedis();
  private readonly queue = new RedisMissionQueue(this.producerRedis);
  private readonly controls = new RunControlPublisher(
    new RedisRunControlTransport(this.controlRedis)
  );
  private readonly bridges = new Map<string, ActiveBridge>();
  private readonly queueEventsRedis = createWorkerRedis();
  private readonly queueEvents = new QueueEvents(MISSION_QUEUE_NAME, {
    connection: this.queueEventsRedis,
  });

  constructor() {
    // MultiAgentRuntime normally emits the terminal event itself. This listener
    // covers failures outside that runtime (worker crash, process kill, BullMQ
    // stalled-job exhaustion) so the API never leaves a dead mission "running".
    this.queueEvents.on("failed", ({ jobId, failedReason }) => {
      if (!jobId) return;
      const active = this.bridges.get(String(jobId));
      const store = active?.store;
      const run = store?.get(String(jobId));
      if (!store || !run || ["completed", "error", "cancelled"].includes(run.status)) return;

      store.emit(String(jobId), "run.error", {
        message: `Distributed worker job failed: ${failedReason || "unknown worker failure"}`,
        distributed: true,
      });
      store.setStatus(String(jobId), "error");
      active?.bridge.stop();
    });

    this.queueEvents.on("error", (err) => {
      console.error("[distributed-mission-coordinator] BullMQ QueueEvents error", err);
    });
  }

  async enqueue(payload: MissionJobPayload, store: RunStore): Promise<void> {
    this.ensureBridge(payload.runId, store);
    await this.queue.enqueue(payload);
  }

  ensureBridge(runId: string, store: RunStore): void {
    if (this.bridges.has(runId)) return;

    const redis = createWorkerRedis();
    const transport = new RedisRunEventTransport(redis);
    const bridge = new RedisRunEventBridge(runId, store, transport);

    const task = bridge
      .run()
      .catch((err) => {
        const run = store.get(runId);
        if (run && !["completed", "error", "cancelled"].includes(run.status)) {
          store.emit(runId, "run.error", {
            message: `Distributed event bridge failed: ${err?.message ?? err}`,
          });
          store.setStatus(runId, "error");
        }
      })
      .finally(() => {
        redis.disconnect();
        this.bridges.delete(runId);
      });

    this.bridges.set(runId, { bridge, redis, task, store });
  }

  async cancel(runId: string, tenantId: string): Promise<void> {
    await this.controls.cancel(runId, tenantId);
  }

  async steer(runId: string, tenantId: string, text: string): Promise<void> {
    await this.controls.steer(runId, tenantId, text);
  }

  async approval(
    runId: string,
    tenantId: string,
    callId: string,
    approved: boolean,
    scope: ApprovalScope
  ): Promise<void> {
    await this.controls.approval(runId, tenantId, callId, approved, scope);
  }

  async stats() {
    return this.queue.stats();
  }
}

let singleton: DistributedMissionCoordinator | undefined;

export function getDistributedMissionCoordinator(): DistributedMissionCoordinator {
  singleton ??= new DistributedMissionCoordinator();
  return singleton;
}

/** Run marker used by API control routes to decide local vs distributed ownership. */
export function isDistributedRun(run: Run): boolean {
  return run.events.some(
    (event) => event.type === "run.queued" && event.data.distributed === true
  );
}

/** Find the active distributed run currently waiting on a given call id. */
export function findDistributedApprovalRun(
  runs: Run[],
  callId: string
): Run | undefined {
  return runs.find((run) => {
    if (!isDistributedRun(run)) return false;
    if (["completed", "error", "cancelled"].includes(run.status)) return false;

    const requested = run.events.some(
      (event) =>
        event.type === "approval.required" &&
        String(event.data.callId ?? "") === callId
    );
    if (!requested) return false;

    const resolved = run.events.some(
      (event) =>
        event.type === "approval.resolved" &&
        String(event.data.callId ?? "") === callId
    );
    return !resolved;
  });
}
