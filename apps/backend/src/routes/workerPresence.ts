/** Heartbeat freshness for registered workers. Stale rows are offline. */

export const WORKER_STALE_MS = 45_000;

export function isWorkerOnline(
  worker: { status?: string; lastHeartbeat?: number } | null | undefined,
  now = Date.now()
): boolean {
  if (!worker) return false;
  if (worker.status === "offline") return false;
  if (typeof worker.lastHeartbeat !== "number") return false;
  return now - worker.lastHeartbeat < WORKER_STALE_MS;
}

export function countOnlineWorkers(
  workers: Iterable<{ status?: string; lastHeartbeat?: number }>,
  now = Date.now()
): number {
  let n = 0;
  for (const w of workers) if (isWorkerOnline(w, now)) n += 1;
  return n;
}
