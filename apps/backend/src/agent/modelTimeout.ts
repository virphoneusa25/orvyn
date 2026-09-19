// apps/backend/src/agent/modelTimeout.ts
//
// Every provider call gets a hard ceiling. Without one, a TCP black hole
// (proxy drop, half-open connection) leaves the call pending forever and the
// UI shows "Astra is analyzing your request…" for eternity — the exact
// freeze the runtime-repair spec forbids.
//
// ORVYN_MODEL_CALL_TIMEOUT_MS bounds each individual generate call
// (default 300000 = 5 minutes; 0 disables). User-initiated Stop still wins:
// the run's own AbortSignal is composed in, so cancelling aborts immediately
// rather than waiting out the timeout.

export function modelCallTimeoutMs(): number {
  const raw = Number(process.env.ORVYN_MODEL_CALL_TIMEOUT_MS);
  if (!Number.isFinite(raw)) return 300_000;
  return Math.max(0, Math.floor(raw));
}

/** Composes the run's cancel signal with the per-call timeout. */
export function modelCallSignal(parent: AbortSignal | undefined): AbortSignal {
  const ms = modelCallTimeoutMs();
  if (ms <= 0) return parent ?? new AbortController().signal;
  // Node ≥20: compose without muting either source. The timeout aborts with
  // a TimeoutError (not AbortError), so Stop-vs-timeout stays distinguishable
  // and transient-retry policy treats it as a real failure to surface.
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
