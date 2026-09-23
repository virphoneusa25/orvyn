// Stale-while-revalidate catalog cache. Memory first; optional persist to
// ORVYN app data. Never stores secrets — only normalized public listings.

export const CATALOG_FRESH_TTL_MS = 5 * 60 * 1000;
export const CATALOG_STALE_TTL_MS = 45 * 60 * 1000;
export const CATALOG_CACHE_MAX = 64;

export interface CatalogCacheEntry<T> {
  at: number;
  payload: T;
}

export type CacheFreshness = "fresh" | "stale" | "miss";

export interface CatalogCacheStore {
  load(): Record<string, CatalogCacheEntry<unknown>>;
  save(value: Record<string, CatalogCacheEntry<unknown>>): void;
}

export function catalogCacheKey(input: {
  provider?: string;
  query: string;
  filters?: string;
  page?: string | number;
}): string {
  return [
    "v3",
    (input.provider ?? "federated").toLowerCase(),
    String(input.query ?? "").trim().toLowerCase().slice(0, 200),
    String(input.filters ?? ""),
    String(input.page ?? ""),
  ].join("|");
}

export class CatalogCache<T> {
  private mem = new Map<string, CatalogCacheEntry<T>>();
  hits = 0;
  misses = 0;
  staleHits = 0;

  constructor(private persist?: CatalogCacheStore) {
    this.hydrate();
  }

  freshness(at: number, now = Date.now()): CacheFreshness {
    const age = now - at;
    if (age < CATALOG_FRESH_TTL_MS) return "fresh";
    if (age < CATALOG_STALE_TTL_MS) return "stale";
    return "miss";
  }

  get(key: string, now = Date.now()): { payload: T; freshness: CacheFreshness; at: number } | undefined {
    const hit = this.mem.get(key);
    if (!hit) {
      this.misses += 1;
      return undefined;
    }
    const freshness = this.freshness(hit.at, now);
    if (freshness === "miss") {
      this.mem.delete(key);
      this.misses += 1;
      return undefined;
    }
    if (freshness === "fresh") this.hits += 1;
    else this.staleHits += 1;
    return { payload: hit.payload, freshness, at: hit.at };
  }

  set(key: string, payload: T, now = Date.now()): void {
    this.mem.set(key, { at: now, payload });
    this.persistBound();
  }

  invalidate(prefix?: string): void {
    if (!prefix) {
      this.mem.clear();
    } else {
      for (const key of [...this.mem.keys()]) {
        if (key.startsWith(prefix) || key.includes(`|${prefix}|`) || key.includes(prefix)) this.mem.delete(key);
      }
    }
    this.persistBound();
  }

  size(): number {
    return this.mem.size;
  }

  private hydrate(): void {
    if (!this.persist) return;
    try {
      const raw = this.persist.load() ?? {};
      const now = Date.now();
      for (const [key, entry] of Object.entries(raw)) {
        if (!entry || typeof entry.at !== "number") continue;
        if (this.freshness(entry.at, now) === "miss") continue;
        this.mem.set(key, entry as CatalogCacheEntry<T>);
      }
    } catch {
      /* corrupt cache is ignorable */
    }
  }

  private persistBound(): void {
    if (!this.persist) return;
    const now = Date.now();
    const rows = [...this.mem.entries()]
      .filter(([, entry]) => this.freshness(entry.at, now) !== "miss")
      .sort((a, b) => b[1].at - a[1].at)
      .slice(0, CATALOG_CACHE_MAX);
    this.mem = new Map(rows);
    const obj: Record<string, CatalogCacheEntry<unknown>> = {};
    for (const [key, entry] of rows) obj[key] = entry;
    try {
      this.persist.save(obj);
    } catch {
      /* disk full / read-only — keep memory */
    }
  }
}

export function settingCacheStore(store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void }, key = "mcp.marketplace.catalogCache.v3"): CatalogCacheStore {
  return {
    load() {
      try {
        const raw = store.getSetting(key);
        return raw ? (JSON.parse(String(raw)) as Record<string, CatalogCacheEntry<unknown>>) : {};
      } catch {
        return {};
      }
    },
    save(value) {
      store.setSetting(key, JSON.stringify(value));
    },
  };
}
