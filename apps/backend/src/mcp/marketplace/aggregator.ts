import { HashingEmbedder } from "../../indexing/embeddings";
import { CatalogCache, catalogCacheKey } from "./catalogCache";
import { primarySearchTerm, searchTokens } from "./classify";
import {
  CatalogProviderError,
  classifyThrown,
  healthFromErrorClass,
  logProviderFailure,
  PROVIDER_TIMEOUTS_MS,
  withProviderTimeout,
  type ProviderHealthStatus,
} from "./providerRuntime";
import { verificationFor } from "./verifiedCatalog";
import type {
  MarketplaceMcpServer,
  MarketplaceSearchResponse,
  McpRegistryProvider,
  RegistryHealth,
  RegistryResult,
  RegistrySearch,
  RegistrySource,
} from "./types";

export interface AggregatorCachePayload {
  results: RegistryResult[];
  health: RegistryHealth[];
  providers: Record<string, RegistryHealth>;
  degraded: string[];
  cursor?: string;
  dedupeCount: number;
}

const DEFAULT_TIMEOUT: Record<string, number> = { ...PROVIDER_TIMEOUTS_MS, private: PROVIDER_TIMEOUTS_MS.private };

export function canonicalKey(server: MarketplaceMcpServer): string {
  const repo = normalizeRepo(server.repository);
  if (repo) return `repo:${repo}`;
  const pkg = server.packages[0]?.identifier?.toLowerCase().trim();
  if (pkg) return `pkg:${pkg}`;
  const id = stripProviderPrefix(server.canonicalId);
  if (id.includes("/")) return `id:${id.toLowerCase()}`;
  const publisher = (server.publisher ?? "").toLowerCase().trim();
  const name = stripProviderPrefix(server.name).replace(/.*\//, "");
  if (publisher && name) return `pub:${publisher}/${name}`;
  return `name:${name}`;
}

export function mergeServers(a: MarketplaceMcpServer, b: MarketplaceMcpServer): MarketplaceMcpServer {
  const officialFirst = a.sources.includes("official") ? a : b.sources.includes("official") ? b : a;
  const other = officialFirst === a ? b : a;
  const sources = [...new Set([...officialFirst.sources, ...other.sources])] as RegistrySource[];
  const officialDesc = officialFirst.description?.trim() ?? "";
  const otherDesc = other.description?.trim() ?? "";
  return {
    ...other,
    ...officialFirst,
    sources,
    description: officialDesc || otherDesc,
    publisher: officialFirst.publisher ?? other.publisher,
    repository: officialFirst.repository ?? other.repository,
    homepage: officialFirst.homepage ?? other.homepage,
    categories: [...new Set([...(officialFirst.categories ?? []), ...(other.categories ?? [])])],
    packages: officialFirst.packages.length ? officialFirst.packages : other.packages,
    remotes: officialFirst.remotes?.length ? officialFirst.remotes : other.remotes,
    transports: officialFirst.transports.length ? officialFirst.transports : other.transports,
    tools: (other.tools?.length && !officialFirst.tools?.length ? other.tools : officialFirst.tools ?? other.tools) ?? [],
    auth: officialFirst.auth.length ? officialFirst.auth : other.auth,
    qualityNote: officialFirst.qualityNote ?? other.qualityNote,
    iconUrl: officialFirst.iconUrl ?? other.iconUrl,
    installed: officialFirst.installed ?? other.installed,
    toolCount: officialFirst.toolCount ?? other.toolCount ?? other.tools?.length ?? officialFirst.tools?.length,
    version: officialFirst.version ?? other.version,
    trust: officialFirst.sources.includes("official") ? officialFirst.trust : other.trust,
  };
}

export function rankServer(query: string, server: MarketplaceMcpServer, extraTools: { name: string; description: string }[] = []): number {
  const q = query.toLowerCase().trim();
  const tokens = searchTokens(query);
  const name = server.name.toLowerCase();
  const title = (server.title ?? "").toLowerCase();
  const canonical = server.canonicalId.toLowerCase();
  const publisher = (server.publisher ?? "").toLowerCase();
  const hay = `${name} ${title} ${server.description} ${publisher} ${server.categories.join(" ")}`.toLowerCase();
  const toolHay = extraTools.map((t) => `${t.name} ${t.description}`).join(" ").toLowerCase();
  let score = 0;
  if (q && (name === q || title === q || canonical === q)) score += 100;
  if (q && canonical.endsWith(`/${q}`)) score += 70;
  if (q && publisher === q) score += 24;
  if (q && hay.includes(q)) score += 40;
  for (const t of tokens) {
    if (hay.includes(t)) score += 12;
    if (toolHay.includes(t)) score += 16;
    if (canonical.includes(t)) score += 10;
  }
  if (isCanonicalGithub(server) && (!q || /github/.test(q))) score += 90;
  if (isCanonicalPostgres(server) && /postgres|postgresql/.test(q)) score += 70;
  if (server.sources.includes("official")) score += 8;
  if (server.sources.includes("local") && server.installed) score += 20;
  if (server.trust.level === "verified") score += 10;
  else if (server.trust.level === "community") score += 4;
  if (server.trust.level === "blocked") score -= 1000;
  if (server.compatibility === "compatible") score += 3;
  if (server.installed?.state === "CONNECTED") score += 6;
  return score;
}

export function isCanonicalGithub(server: Pick<MarketplaceMcpServer, "name" | "title" | "repository" | "canonicalId" | "publisher">): boolean {
  if (/io\.github\.github\/github-mcp-server/i.test(server.name) || /io\.github\.github\/github-mcp-server/i.test(server.canonicalId)) return true;
  if (/github\.com\/github\/github-mcp-server/i.test(server.repository ?? "")) return true;
  return /^(github|github mcp)$/i.test((server.title ?? "").trim()) && /github\.com\/github\//i.test(server.repository ?? "");
}

export function isCanonicalPostgres(server: Pick<MarketplaceMcpServer, "name" | "title" | "canonicalId">): boolean {
  return /postgres(ql)?-mcp|\/postgres(ql)?(\b|$)/i.test(`${server.name} ${server.canonicalId} ${server.title ?? ""}`);
}

export class RegistryAggregator {
  readonly cache: CatalogCache<AggregatorCachePayload>;
  private embedder = new HashingEmbedder(64);
  private refreshing = new Set<string>();
  private timeouts: Record<string, number>;

  constructor(
    private providers: McpRegistryProvider[],
    cache?: CatalogCache<AggregatorCachePayload>,
    timeouts?: Partial<Record<string, number>>
  ) {
    this.cache = cache ?? new CatalogCache<AggregatorCachePayload>();
    this.timeouts = { ...DEFAULT_TIMEOUT };
    for (const [id, ms] of Object.entries(timeouts ?? {})) {
      if (typeof ms === "number") this.timeouts[id] = ms;
    }
  }

  replaceProviders(providers: McpRegistryProvider[]): void {
    this.providers = providers;
  }

  invalidate(query?: string): void {
    this.cache.invalidate(query);
  }

  async health(): Promise<RegistryHealth[]> {
    const rows = await Promise.allSettled(
      this.providers.map((p) =>
        withProviderTimeout(
          (p.health ?? (async () => ({ id: p.id, name: p.name, status: "online" as const })))(),
          timeoutFor(p.id, this.timeouts),
          p.id
        )
      )
    );
    return rows.map((row, i) => {
      const p = this.providers[i];
      if (row.status === "fulfilled") return row.value;
      const err = classifyThrown(row.reason, p.id);
      return { id: p.id, name: p.name, status: healthFromErrorClass(err.errorClass), detail: err.message.slice(0, 160) };
    });
  }

  async search(query: RegistrySearch): Promise<MarketplaceSearchResponse> {
    const key = catalogCacheKey({
      query: query.query,
      filters: query.category ?? "",
      page: `${query.limit ?? 24}:${query.cursor ?? ""}`,
    });
    const cached = query.refresh ? undefined : this.cache.get(key);
    if (cached?.freshness === "fresh") {
      return envelope(cached.payload, { fromCache: true, stale: false, cache: "hit" });
    }
    if (cached?.freshness === "stale") {
      this.refreshInBackground(key, query);
      return envelope(cached.payload, { fromCache: true, stale: true, cache: "stale" });
    }
    const live = await this.federate(query);
    if (cacheable(live)) this.cache.set(key, live);
    return envelope(live, { fromCache: false, stale: false, cache: "miss" });
  }

  private refreshInBackground(key: string, query: RegistrySearch): void {
    if (this.refreshing.has(key)) return;
    this.refreshing.add(key);
    void this.federate(query)
      .then((live) => {
        if (cacheable(live)) this.cache.set(key, live);
      })
      .catch(() => undefined)
      .finally(() => this.refreshing.delete(key));
  }

  private async federate(query: RegistrySearch): Promise<AggregatorCachePayload> {
    const term = primarySearchTerm(query.query);
    const settled = await Promise.allSettled(
      this.providers.map((p) => this.searchProvider(p, p.id === "official" ? { ...query, query: term } : query))
    );
    const health: RegistryHealth[] = [];
    const providers: Record<string, RegistryHealth> = {};
    const degraded: string[] = [];
    const chunks: RegistryResult[][] = [];
    settled.forEach((row, i) => {
      const p = this.providers[i];
      if (row.status === "fulfilled") {
        health.push(row.value.health);
        providers[p.id] = row.value.health;
        chunks.push(row.value.results);
        if (row.value.health.status !== "online" && row.value.health.status !== "disabled") {
          if (row.value.health.detail) degraded.push(`${p.name}: ${row.value.health.detail}`);
        }
        return;
      }
      const err = classifyThrown(row.reason, p.id);
      const h: RegistryHealth = {
        id: p.id,
        name: p.name,
        status: healthFromErrorClass(err.errorClass),
        detail: err.message.slice(0, 160),
        errorClass: err.errorClass,
        resultCount: 0,
      };
      health.push(h);
      providers[p.id] = h;
      if (p.id !== "local") degraded.push(`${p.name}: ${h.detail}`);
      chunks.push([]);
    });

    const merged = new Map<string, RegistryResult>();
    let incoming = 0;
    for (const chunk of chunks) {
      for (const row of chunk) {
        incoming += 1;
        const k = canonicalKey(row.server);
        const prev = merged.get(k);
        if (!prev) {
          merged.set(k, row);
        } else {
          merged.set(k, {
            server: mergeServers(prev.server, row.server),
            score: 0,
            matchedTools: [...(prev.matchedTools ?? []), ...(row.matchedTools ?? [])].slice(0, 8),
          });
        }
      }
    }
    const qVec = await this.embedder.embed(query.query || "mcp server");
    const results: RegistryResult[] = [];
    for (const row of merged.values()) {
      if (query.category && !row.server.categories.includes(query.category)) continue;
      const verified = verificationFor(row.server);
      if (verified) row.server.trust = verified;
      const lexical = rankServer(query.query, row.server, row.matchedTools ?? row.server.tools ?? []);
      const doc = `${row.server.name} ${row.server.description} ${(row.matchedTools ?? []).map((t) => t.name).join(" ")}`;
      const dVec = await this.embedder.embed(doc);
      const semantic = cosine(qVec, dVec) * 30;
      results.push({ ...row, score: lexical + semantic });
    }
    results.sort((a, b) => b.score - a.score);
    return {
      results: results.slice(0, query.limit ?? 24),
      health,
      providers,
      degraded,
      dedupeCount: Math.max(0, incoming - merged.size),
    };
  }

  private async searchProvider(
    provider: McpRegistryProvider,
    query: RegistrySearch
  ): Promise<{ results: RegistryResult[]; health: RegistryHealth }> {
    const timeoutMs = timeoutFor(provider.id, this.timeouts);
    const started = Date.now();
    try {
      const out = await withProviderTimeout(provider.search(query), timeoutMs, provider.id);
      const latencyMs = Date.now() - started;
      const hinted = out.health;
      const status: ProviderHealthStatus = hinted?.status ?? healthFromErrorClass(undefined, latencyMs, timeoutMs);
      return {
        results: out.results,
        health: {
          id: provider.id,
          name: provider.name,
          status,
          latencyMs,
          resultCount: out.results.length,
          detail: hinted?.detail ?? (status === "slow" ? `${provider.name} is responding slowly` : undefined),
          errorClass: hinted?.errorClass,
        },
      };
    } catch (err) {
      const classified = err instanceof CatalogProviderError ? err : classifyThrown(err, provider.id);
      const latencyMs = Date.now() - started;
      logProviderFailure({
        provider: provider.id,
        query: query.query,
        duration: latencyMs,
        status: classified.status,
        errorClass: classified.errorClass,
      });
      throw classified;
    }
  }
}

function envelope(
  payload: AggregatorCachePayload,
  meta: { fromCache: boolean; stale: boolean; cache: "hit" | "stale" | "miss" }
): MarketplaceSearchResponse {
  const remotes = payload.health.filter((h) => h.id !== "local");
  const remoteFailed = remotes.filter((h) => !["online", "needs-key", "disabled"].includes(h.status));
  const degradedFlag = remoteFailed.length > 0 || payload.degraded.length > 0;
  return {
    results: payload.results,
    health: payload.health,
    providers: payload.providers,
    degraded: payload.degraded,
    degradedFlag,
    fromCache: meta.fromCache,
    stale: meta.stale,
    diagnostics: {
      cache: meta.cache,
      resultCount: payload.results.length,
      dedupeCount: payload.dedupeCount,
      providerLatency: Object.fromEntries(payload.health.map((h) => [h.id, h.latencyMs ?? 0])),
    },
  };
}

function cacheable(payload: AggregatorCachePayload): boolean {
  if (payload.results.length) return true;
  const remotes = payload.health.filter((h) => h.id !== "local" && h.status !== "disabled" && h.status !== "needs-key");
  return remotes.length > 0 && remotes.every((h) => h.status === "online");
}

function timeoutFor(id: string, overrides?: Record<string, number>): number {
  if (overrides?.[id] != null) return overrides[id];
  return DEFAULT_TIMEOUT[id] ?? PROVIDER_TIMEOUTS_MS.private;
}

function normalizeRepo(url?: string): string {
  return String(url ?? "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .replace(/^https?:\/\/(www\.)?github\.com\//i, "github.com/")
    .toLowerCase();
}

function stripProviderPrefix(value: string): string {
  return String(value ?? "").replace(/^(glama|smithery|local|private):/i, "");
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
