// apps/backend/src/services/modelRetries.ts
//
// Retry with exponential backoff for TRANSIENT provider failures only.
//
// The distinction that matters:
//   - transient: HTTP 429 rate limits, HTTP 5xx, dropped connections. The
//     right response is to wait and try again — one hiccup must not fail a
//     40-step mission.
//   - permanent: auth errors (401/403/404), bad requests (400), exhausted
//     quota ("no credits" 429s). Retrying these wastes tens of seconds of
//     backoff and still fails; they must surface immediately.
//   - deliberate: AbortError means the user pressed Stop. Retrying a
//     cancellation would be actively wrong.

export interface RetryOptions {
  maxAttempts?: number;
  /** Base delay for the exponential backoff, ms. */
  baseDelayMs?: number;
  /** Logged per retry so failures are diagnosable from server logs. */
  label?: string;
  /** When aborted, stops sleeping between attempts. */
  signal?: AbortSignal;
}

const DEFAULTS = { maxAttempts: 3, baseDelayMs: 600 };

const TRANSIENT_PATTERNS: RegExp[] = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ESOCKETTIMEDOUT/,
  /ENOTFOUND/,
  /EAI_AGAIN/,
  /ECONNREFUSED/,
  /fetch failed/i,
  /socket hang up/i,
  /network error/i,
  /service unavailable/i,
  /bad gateway/i,
  /overloaded/i,
];

const PERMANENT_PATTERNS: RegExp[] = [
  // A 429 about exhausted quota is permanent: the account is out of money.
  /insufficient_quota/i,
  /no credits/i,
  /invalid_api_key/i,
  /incorrect api key/i,
  /permission denied/i,
];

export function isTransientError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as Error)?.name ?? "";
  const message = String((err as Error)?.message ?? err);

  if (name === "AbortError") return false;
  if (PERMANENT_PATTERNS.some((p) => p.test(message))) return false;

  // Status codes decide when present: rate-limit/request-timeout and any 5xx
  // are transient; every other 4xx is a permanent client error. (Adapters
  // embed the code in the message — e.g. 'returned HTTP 429: …'.)
  const status = message.match(/HTTP (\d{3})/);
  if (status) {
    const code = Number(status[1]);
    if (code === 429 || code === 408 || code >= 500) return true;
    if (code >= 400 && code < 500) return false;
  }

  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("Retries aborted"), { name: "AbortError" }));
      },
      { once: true }
    );
  });
}

/**
 * Runs an async operation with retry on transient failures. Permanent errors
 * and aborts rethrow on the first attempt; transient ones back off
 * exponentially with jitter.
 */
export async function withModelRetries<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULTS.maxAttempts;
  const base = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const aborted = err?.name === "AbortError";
      if (aborted || attempt >= maxAttempts || !isTransientError(err)) throw err;

      const delay = base * 2 ** (attempt - 1) * (0.7 + Math.random() * 0.6);
      console.warn(
        `[model-retry] ${opts.label ?? "model call"} attempt ${attempt}/${maxAttempts} failed transiently ` +
          `(${String(err?.message ?? err).slice(0, 140)}); retrying in ${Math.round(delay)}ms`
      );
      await sleep(delay, opts.signal);
    }
  }
}
