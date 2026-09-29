import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

// A small query cache for the Admin Portal: stale-while-revalidate per path,
// so moving between pages shows the last data at once (no layout jumps), and
// invalidate("/admin/customers") refreshes everything under a prefix.

interface Entry { data: unknown; at: number; promise?: Promise<unknown> }
const cache = new Map<string, Entry>();
const subs = new Map<string, Set<() => void>>();

function notify(key: string) { subs.get(key)?.forEach((f) => f()); }

export function invalidate(prefix: string): void {
  for (const k of [...cache.keys()]) {
    if (!k.startsWith(prefix)) continue;
    // Someone is showing it: refetch in place (the old data stays until the new arrives).
    if (subs.get(k)?.size) { const e = cache.get(k)!; e.at = 0; void load(k).catch(() => undefined); }
    else cache.delete(k);
  }
}

async function load(path: string): Promise<unknown> {
  const e = cache.get(path);
  if (e?.promise) return e.promise;
  const promise = api(path).then((data) => { cache.set(path, { data, at: Date.now() }); notify(path); return data; })
    .finally(() => { const cur = cache.get(path); if (cur?.promise) delete cur.promise; });
  cache.set(path, { data: e?.data, at: e?.at ?? 0, promise });
  return promise;
}

export interface Query<T> { data: T | null; error: ApiError | null; loading: boolean; reload: () => void }

export function useQuery<T>(path: string | null, opts: { staleMs?: number; refreshMs?: number } = {}): Query<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const [, force] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const run = useCallback(() => {
    if (!path) return;
    load(path).then(() => { if (mounted.current) setError(null); }).catch((e) => { if (mounted.current) setError(e instanceof ApiError ? e : new ApiError(0, "Network error — check your connection.")); });
  }, [path]);
  useEffect(() => {
    if (!path) return;
    const f = () => force((n) => n + 1);
    if (!subs.has(path)) subs.set(path, new Set());
    subs.get(path)!.add(f);
    const e = cache.get(path);
    if (!e || Date.now() - e.at > staleMs) run();
    return () => { subs.get(path)?.delete(f); };
  }, [path, run, staleMs]);
  useEffect(() => {
    if (!path || !opts.refreshMs) return;
    const t = window.setInterval(run, opts.refreshMs);
    return () => window.clearInterval(t);
  }, [path, opts.refreshMs, run]);
  const e = path ? cache.get(path) : undefined;
  return { data: (e?.data as T) ?? null, error, loading: Boolean(path && (!e || e.data === undefined) && !error), reload: () => { if (path) { cache.delete(path); run(); } } };
}

/** Debounced value (search boxes). */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => setV(value), ms); return () => window.clearTimeout(t); }, [value, ms]);
  return v;
}

/** Friendly text for an error (never a raw server trace). */
export function errorText(e: ApiError | null): string {
  if (!e) return "";
  if (e.status === 0) return "Couldn't reach ORVYN. Check your connection and retry.";
  if (e.status === 403) return e.message || "You don't have permission to see this.";
  if (e.code === "STRIPE_UNAVAILABLE") return "Stripe isn't configured on this server.";
  if (e.status >= 500) return "Something went wrong on the server. Retry in a moment.";
  return e.message;
}
