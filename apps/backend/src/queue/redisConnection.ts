// apps/backend/src/queue/redisConnection.ts
import IORedis, { Redis, RedisOptions } from "ioredis";

function redisUrl(): string {
  const value = process.env.ORVYN_REDIS_URL?.trim();
  if (!value) throw new Error("ORVYN_REDIS_URL is required for distributed missions");
  return value;
}

export function createProducerRedis(): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  return new IORedis(redisUrl(), options);
}

export function createWorkerRedis(): Redis {
  const options: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
  };
  return new IORedis(redisUrl(), options);
}

export function distributedMissionsEnabled(): boolean {
  return process.env.ORVYN_DISTRIBUTED_MISSIONS?.trim() === "1";
}


export function distributedControlsEnabled(): boolean {
  return process.env.ORVYN_DISTRIBUTED_CONTROLS?.trim() === "1";
}

export function distributedRuntimeReady(): boolean {
  return distributedMissionsEnabled() && distributedControlsEnabled();
}
