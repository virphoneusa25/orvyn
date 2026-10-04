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


/**
 * Distributed workers can only execute projects that exist on their shared
 * filesystem. This prevents a cloud backend from accepting a desktop-local
 * path (for example C:\\Users\\... or /Users/...) that the worker cannot
 * actually see.
 */
export function distributedProjectRootEligible(projectRoot: string): boolean {
  if (!distributedRuntimeReady()) return false;
  const root = process.env.ORVYN_DISTRIBUTED_PROJECT_ROOT?.trim() || "/projects";
  const normalizedRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedProject = String(projectRoot || "").replace(/\\/g, "/");
  return (
    normalizedProject === normalizedRoot ||
    normalizedProject.startsWith(`${normalizedRoot}/`)
  );
}
