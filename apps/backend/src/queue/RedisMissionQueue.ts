// apps/backend/src/queue/RedisMissionQueue.ts
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { MISSION_QUEUE_NAME, MissionJobPayload, MissionQueueStats } from "./types";

export class RedisMissionQueue {
  readonly queue: Queue<MissionJobPayload>;

  constructor(connection: Redis) {
    this.queue = new Queue<MissionJobPayload>(MISSION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        removeOnComplete: { age: 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 5000 },
        attempts: 1,
      },
    });
  }

  async enqueue(payload: MissionJobPayload): Promise<string> {
    const job = await this.queue.add("execute-mission", payload, { jobId: payload.runId });
    return String(job.id);
  }

  async stats(): Promise<MissionQueueStats> {
    const counts = await this.queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    return {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      completed: counts.completed ?? 0,
      failed: counts.failed ?? 0,
      delayed: counts.delayed ?? 0,
    };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
