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

// ---------------------------------------------------------------------------
// Provider health and failure classes
//
// A model call can fail for different reasons, and only some of them mean
// "try somewhere else":
//   - "model":    the provider does not serve this model (404, retired). Skip
//                 the model for hours; the provider is fine.
//   - "provider": the provider is overloaded, rate-limited, down or slow
//                 (429, 5xx, timeouts, connection resets). Skip the provider
//                 for a few minutes and run the SAME model on another provider
//                 when one serves it, else an equivalent model.
//   - "auth":     the key is wrong or out of credit (401/402/403). Skip the
//                 provider for longer; retrying there cannot help.
//   - null:       the request itself was bad (400 with a schema error, a tool
//                 argument problem, context too long). Switching providers
//                 would fail the same way, so it is not a failover.
// Health: every provider gets a score from its recent calls; a provider that
// just failed is skipped until its cool-down ends, and each repeat failure
// doubles the cool-down (up to 15 minutes). One success resets it.

export type FailureClass = "model" | "provider" | "auth";

const PROVIDER_DOWN = /\bHTTP (429|500|502|503|504|520|522|524|529)\b|\b(rate[_ ]?limit(ed)?|too many requests|overloaded|capacity|temporarily unavailable|service unavailable|bad gateway|gateway time-?out|upstream|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_|socket hang up|fetch failed|network error|timed? ?out|stream (ended|closed) unexpectedly|terminated)\b/i;
const AUTH = /\bHTTP (401|402|403)\b|\b(invalid api key|incorrect api key|unauthori[sz]ed|insufficient (credits|balance|quota)|quota exceeded|payment required|billing)\b/i;

export function classifyModelFailure(err: unknown): FailureClass | null {
  const message = String((err as Error)?.message ?? err ?? "");
  if (!message) return null;
  // The customer's wallet or plan stopped the call: no other provider may take it.
  if ((err as { billing?: boolean })?.billing === true) return null;
  if ((err as Error)?.name === "AbortError" && /abort/i.test(message) && !/time/i.test(message)) return null; // user cancelled
  if (isModelNotFound(err)) return "model";
  if (AUTH.test(message)) return "auth";
  if (PROVIDER_DOWN.test(message)) return "provider";
  return null;
}

/** The provider part of a registry id ("nebius:zai-org/GLM-5.3" → "nebius"). */
export function providerOf(registryId: string): string {
  const i = registryId.indexOf(":");
  return i > 0 ? registryId.slice(0, i) : registryId;
}

interface ProviderHealth { ok: number; failed: number; streak: number; until: number; lastError?: string }
const providers = new Map<string, ProviderHealth>();
const MAX_COOLDOWN_MS = 15 * 60_000;

function healthOf(provider: string): ProviderHealth {
  let h = providers.get(provider);
  if (!h) providers.set(provider, (h = { ok: 0, failed: 0, streak: 0, until: 0 }));
  return h;
}

/** A call on this provider failed for a provider reason; skip it for a while. */
export function markProviderFailure(registryId: string, kind: "provider" | "auth", reason: string, now = Date.now()): number {
  const h = healthOf(providerOf(registryId));
  h.failed++;
  h.streak++;
  const seconds = Number(process.env.ORVYN_PROVIDER_COOLDOWN_SECONDS);
  const base = kind === "auth" ? 30 * 60_000 : (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000;
  const cooldown = kind === "auth" ? base : Math.min(MAX_COOLDOWN_MS, base * 2 ** (h.streak - 1));
  h.until = now + cooldown;
  h.lastError = reason.slice(0, 200);
  return cooldown;
}

export function markProviderSuccess(registryId: string): void {
  const h = healthOf(providerOf(registryId));
  h.ok++;
  h.streak = 0;
  h.until = 0;
}

export function isProviderCoolingDown(registryId: string, now = Date.now()): boolean {
  const h = providers.get(providerOf(registryId));
  return Boolean(h && h.until > now);
}

/** 0..1: share of recent calls that succeeded (1 for a provider with no history), 0 while cooling down. */
export function providerHealthScore(registryId: string, now = Date.now()): number {
  const h = providers.get(providerOf(registryId));
  if (!h) return 1;
  if (h.until > now) return 0;
  const total = h.ok + h.failed;
  return total === 0 ? 1 : (h.ok + 1) / (total + 1);
}

export function providerHealthSnapshot(now = Date.now()): { provider: string; score: number; coolingDown: boolean; lastError?: string }[] {
  return [...providers.entries()].map(([provider, h]) => ({
    provider,
    score: providerHealthScore(`${provider}:x`, now),
    coolingDown: h.until > now,
    lastError: h.lastError,
  }));
}

/** Not usable right now: the model is missing, or its provider is cooling down. */
export function isRouteBlocked(registryId: string, now = Date.now()): boolean {
  return isModelUnavailable(registryId, now) || isProviderCoolingDown(registryId, now);
}

export function clearProviderHealth(): void {
  providers.clear();
}
