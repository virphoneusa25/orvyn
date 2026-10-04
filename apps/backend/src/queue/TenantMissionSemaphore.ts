// apps/backend/src/queue/TenantMissionSemaphore.ts
//
// Distributed per-tenant mission concurrency guard.
//
// Uses a Redis sorted set of renewable leases instead of a plain counter so a
// worker crash cannot leak a slot forever. Expired leases are removed during
// every acquire. Each active mission renews its lease on a heartbeat.

import type { Redis } from "ioredis";

function key(tenantId: string): string {
  return `orvyn:tenant-mission-slots:${tenantId}`;
}

export class TenantMissionSemaphore {
  constructor(
    private readonly redis: Redis,
    private readonly maxPerTenant: number,
    private readonly leaseMs: number = 120_000
  ) {}

  async acquire(tenantId: string, leaseId: string): Promise<boolean> {
    if (this.maxPerTenant <= 0) return true;
    const now = Date.now();
    const expires = now + this.leaseMs;
    const script = `
      redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
      if redis.call("ZSCORE", KEYS[1], ARGV[3]) then
        redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
        redis.call("PEXPIRE", KEYS[1], ARGV[4])
        return 1
      end
      local count = redis.call("ZCARD", KEYS[1])
      if count >= tonumber(ARGV[5]) then
        return 0
      end
      redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
      redis.call("PEXPIRE", KEYS[1], ARGV[4])
      return 1
    `;
    const result = await this.redis.eval(
      script,
      1,
      key(tenantId),
      String(now),
      String(expires),
      leaseId,
      String(this.leaseMs * 2),
      String(this.maxPerTenant)
    );
    return Number(result) === 1;
  }

  async renew(tenantId: string, leaseId: string): Promise<boolean> {
    if (this.maxPerTenant <= 0) return true;
    const expires = Date.now() + this.leaseMs;
    const script = `
      if not redis.call("ZSCORE", KEYS[1], ARGV[1]) then
        return 0
      end
      redis.call("ZADD", KEYS[1], ARGV[2], ARGV[1])
      redis.call("PEXPIRE", KEYS[1], ARGV[3])
      return 1
    `;
    const result = await this.redis.eval(
      script,
      1,
      key(tenantId),
      leaseId,
      String(expires),
      String(this.leaseMs * 2)
    );
    return Number(result) === 1;
  }

  async release(tenantId: string, leaseId: string): Promise<void> {
    if (this.maxPerTenant <= 0) return;
    const script = `
      redis.call("ZREM", KEYS[1], ARGV[1])
      if redis.call("ZCARD", KEYS[1]) == 0 then
        redis.call("DEL", KEYS[1])
      end
      return 1
    `;
    await this.redis.eval(script, 1, key(tenantId), leaseId);
  }

  startHeartbeat(tenantId: string, leaseId: string): () => void {
    if (this.maxPerTenant <= 0) return () => {};
    const intervalMs = Math.max(5_000, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => {
      void this.renew(tenantId, leaseId).catch((err) => {
        console.error(
          `[tenant-mission-semaphore] lease renewal failed tenant=${tenantId} run=${leaseId}: ${err?.message ?? err}`
        );
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }
}
