// apps/backend/src/models/modelAvailability.ts
//
// A model the provider says does not exist for this account ("Model not
// found, inaccessible, and/or not deployed" — not enabled on the key, retired,
// or renamed) is skipped by the routing policy for a while, so the run falls
// back to the next model on its ladder instead of failing, and later runs do
// not start on it again.

const unavailable = new Map<string, { until: number; reason: string }>();

/** How long a missing model is skipped (default 6 hours; ORVYN_MODEL_UNAVAILABLE_MINUTES). */
function ttlMs(env: NodeJS.ProcessEnv = process.env): number {
  const m = Number(env.ORVYN_MODEL_UNAVAILABLE_MINUTES);
  return (Number.isFinite(m) && m > 0 ? m : 360) * 60_000;
}

const NOT_FOUND = /\b(model[_ ]not[_ ]found|model not found|not deployed|does not exist|no such model|unknown model|invalid model|model .{0,60}(is not|isn't) (available|supported|accessible)|inaccessible|"code"\s*:\s*"NOT_FOUND"|decommissioned|deprecated and (is )?no longer)\b/i;

/** The provider rejected the model itself (not the request): try another model. */
export function isModelNotFound(err: unknown): boolean {
  const message = String((err as Error)?.message ?? err ?? "");
  if (!message) return false;
  if (/HTTP (404|410)\b/.test(message) && /model/i.test(message)) return true;
  return NOT_FOUND.test(message) && /model/i.test(message);
}

export function markModelUnavailable(registryId: string, reason: string, now = Date.now()): void {
  unavailable.set(registryId, { until: now + ttlMs(), reason: reason.slice(0, 300) });
}

export function isModelUnavailable(registryId: string, now = Date.now()): boolean {
  const hit = unavailable.get(registryId);
  if (!hit) return false;
  if (hit.until <= now) {
    unavailable.delete(registryId);
    return false;
  }
  return true;
}

export function clearModelAvailability(): void {
  unavailable.clear();
}
