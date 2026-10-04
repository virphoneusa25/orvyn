// apps/backend/src/queue/WorkerHeartbeat.ts
//
// Lightweight worker liveness registry in orvyn-redis.
//
// Workers publish renewable leases into a sorted set. API readers prune
// expired scores before counting, so a hard-killed worker disappears without
// requiring a graceful shutdown hook.

import type { Redis } from "ioredis";

const WORKERS_KEY = "orvyn:workers:alive";

export class WorkerHeartbeatRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly ttlMs = 30_000
  ) {}

  async beat(workerId: string): Promise<void> {
    const now = Date.now();
    await this.redis
      .multi()
      .zremrangebyscore(WORKERS_KEY, "-inf", now)
      .zadd(WORKERS_KEY, now + this.ttlMs, workerId)
      .exec();
  }

  async remove(workerId: string): Promise<void> {
    await this.redis.zrem(WORKERS_KEY, workerId);
  }

  async activeCount(): Promise<number> {
    const now = Date.now();
    await this.redis.zremrangebyscore(WORKERS_KEY, "-inf", now);
    return this.redis.zcard(WORKERS_KEY);
  }

  start(workerId: string): () => Promise<void> {
    let stopped = false;
    const intervalMs = Math.max(5_000, Math.floor(this.ttlMs / 3));

    void this.beat(workerId).catch((err) => {
      console.error(`[worker-heartbeat] initial beat failed: ${err?.message ?? err}`);
    });

    const timer = setInterval(() => {
      if (stopped) return;
      void this.beat(workerId).catch((err) => {
        console.error(`[worker-heartbeat] beat failed: ${err?.message ?? err}`);
      });
    }, intervalMs);

    return async () => {
      stopped = true;
      clearInterval(timer);
      await this.remove(workerId).catch(() => undefined);
    };
  }
}
