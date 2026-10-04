// apps/backend/src/queue/RedisMissionStateStore.ts
//
// Lightweight distributed mission ownership/status record.
//
// This is NOT the long-term historical database. PostgreSQL/LocalStore remains
// the durable product record. Redis provides the live cross-process truth that
// API instances and workers need while a BullMQ mission is active.

import type { Redis } from "ioredis";
import type { RunStatus } from "../agent/events";
import type { MissionJobPayload } from "./types";

export interface DistributedMissionState {
  runId: string;
  tenantId: string;
  projectRoot: string;
  status: RunStatus;
  requestedAt: string;
  updatedAt: string;
  workerStartedAt?: string;
  completedAt?: string;
  error?: string;
}

const TTL_SECONDS = 14 * 24 * 60 * 60;

function key(runId: string): string {
  return `orvyn:mission-state:${runId}`;
}

export class RedisMissionStateStore {
  constructor(private readonly redis: Redis) {}

  async create(payload: MissionJobPayload): Promise<void> {
    const now = new Date().toISOString();
    await this.redis
      .multi()
      .hset(key(payload.runId), {
        runId: payload.runId,
        tenantId: payload.tenantId,
        projectRoot: payload.projectRoot,
        status: "queued",
        requestedAt: payload.requestedAt,
        updatedAt: now,
      })
      .expire(key(payload.runId), TTL_SECONDS)
      .exec();
  }

  async setStatus(
    runId: string,
    status: RunStatus,
    extra: { error?: string; workerStartedAt?: string; completedAt?: string } = {}
  ): Promise<void> {
    const values: Record<string, string> = {
      status,
      updatedAt: new Date().toISOString(),
    };
    if (extra.error) values.error = extra.error;
    if (extra.workerStartedAt) values.workerStartedAt = extra.workerStartedAt;
    if (extra.completedAt) values.completedAt = extra.completedAt;

    await this.redis
      .multi()
      .hset(key(runId), values)
      .expire(key(runId), TTL_SECONDS)
      .exec();
  }

  async get(runId: string): Promise<DistributedMissionState | null> {
    const data = await this.redis.hgetall(key(runId));
    if (!data.runId) return null;
    return {
      runId: data.runId,
      tenantId: data.tenantId,
      projectRoot: data.projectRoot,
      status: data.status as RunStatus,
      requestedAt: data.requestedAt,
      updatedAt: data.updatedAt,
      ...(data.workerStartedAt ? { workerStartedAt: data.workerStartedAt } : {}),
      ...(data.completedAt ? { completedAt: data.completedAt } : {}),
      ...(data.error ? { error: data.error } : {}),
    };
  }
}
