// apps/backend/src/middleware/rateLimit.ts
//
// Per-tenant request rate limiting (token bucket). Without this, one customer
// — or one runaway script with a valid key — can saturate the box for
// everyone (commercial-readiness item: "Rate limiting: none").
//
// Two limiters ship:
//   - tenantRateLimit: keyed by tenant id, mounted after resolveTenant.
//     ORVYN_RATE_LIMIT_RPM (default 300, 0 disables).
//   - ipRateLimit: keyed by client IP, for the unauthenticated auth routes
//     so register/login can't be hammered. ORVYN_AUTH_RATE_LIMIT_RPM
//     (default 30, 0 disables).
//
// Buckets refill continuously; burst capacity equals one minute of budget.
// Denials return 429 with Retry-After and X-RateLimit-* headers.

import { Request, Response, NextFunction } from "express";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    /** Sustained budget in requests per minute. */
    public readonly ratePerMinute: number,
    /** Max burst; defaults to one minute of budget. */
    public readonly burst: number = ratePerMinute
  ) {}

  /** Returns ok, or how long the caller must wait for the next token. */
  take(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
    if (this.ratePerMinute <= 0) return { ok: true }; // disabled
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.burst, lastRefillMs: now };
      this.buckets.set(key, b);
    }
    // Continuous refill since last touch, capped at burst.
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.lastRefillMs) / 60_000) * this.ratePerMinute);
    b.lastRefillMs = now;

    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.prune();
      return { ok: true };
    }
    const retryAfterSec = Math.max(1, Math.ceil(((1 - b.tokens) / this.ratePerMinute) * 60));
    return { ok: false, retryAfterSec };
  }

  remaining(key: string): number {
    const b = this.buckets.get(key);
    return b ? Math.floor(b.tokens) : this.burst;
  }

  /** Drop buckets that have fully refilled — they carry no state worth keeping. */
  private prune(): void {
    if (this.buckets.size < 10_000) return;
    const now = Date.now();
    for (const [key, b] of this.buckets) {
      const refilled = b.tokens + ((now - b.lastRefillMs) / 60_000) * this.ratePerMinute;
      if (refilled >= this.burst) this.buckets.delete(key);
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function deny(res: Response, limiter: TokenBucketLimiter, retryAfterSec: number): void {
  res.setHeader("Retry-After", String(retryAfterSec));
  res.setHeader("X-RateLimit-Limit", String(limiter.ratePerMinute));
  res.setHeader("X-RateLimit-Remaining", "0");
  res.status(429).json({
    error: `Rate limit exceeded (${limiter.ratePerMinute} requests/minute). Retry in ${retryAfterSec}s.`,
  });
}

/** Per-tenant limiter. Mount AFTER resolveTenant so req.tenant is set. */
export function tenantRateLimit() {
  const limiter = new TokenBucketLimiter(envInt("ORVYN_RATE_LIMIT_RPM", 300));
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.tenant?.id ?? req.ip ?? "unknown";
    const verdict = limiter.take(key);
    if (!verdict.ok) return deny(res, limiter, verdict.retryAfterSec);
    res.setHeader("X-RateLimit-Limit", String(limiter.ratePerMinute));
    res.setHeader("X-RateLimit-Remaining", String(limiter.remaining(key)));
    next();
  };
}

/** Per-IP limiter for unauthenticated routes (register/login). */
export function ipRateLimit() {
  const limiter = new TokenBucketLimiter(envInt("ORVYN_AUTH_RATE_LIMIT_RPM", 30));
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = limiter.take(req.ip ?? "unknown");
    if (!verdict.ok) return deny(res, limiter, verdict.retryAfterSec);
    next();
  };
}
