import { HashingEmbedder } from "../../indexing/embeddings";
import { primarySearchTerm, searchTokens } from "./classify";
import { verificationFor } from "./verifiedCatalog";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistryResult, RegistrySearch, RegistrySource } from "./types";

const CACHE_TTL_MS = 5 * 60 * 1000;

export function canonicalKey(server: MarketplaceMcpServer): string {
  const repo = (server.repository ?? "").replace(/\.git$/, "").toLowerCase();
  const pkg = server.packages[0]?.identifier?.toLowerCase() ?? "";
  const name = server.name.toLowerCase().replace(/^glama:/, "");
  if (repo) return `repo:${repo}`;
  if (pkg) return `pkg:${pkg}`;
  return `name:${name.replace(/.*\//, "")}`;
}

export function mergeServers(a: MarketplaceMcpServer, b: MarketplaceMcpServer): MarketplaceMcpServer {
  const sources = [...new Set([...a.sources, ...b.sources])] as RegistrySource[];
  return {
    ...a,
    sources,
    description: a.description.length >= b.description.length ? a.description : b.description,
    publisher: a.publisher ?? b.publisher,
    repository: a.repository ?? b.repository,
    homepage: a.homepage ?? b.homepage,
    categories: [...new Set([...a.categories, ...b.categories])],
    packages: a.packages.length ? a.packages : b.packages,
    transports: a.transports.length ? a.transports : b.transports,
    tools: (a.tools?.length ? a.tools : b.tools) ?? [],
    auth: a.auth.length ? a.auth : b.auth,
    qualityNote: a.qualityNote ?? b.qualityNote,
    installed: a.installed ?? b.installed,
    toolCount: a.toolCount ?? b.toolCount,
    version: a.version ?? b.version,
  };
}

export function rankServer(query: string, server: MarketplaceMcpServer, extraTools: { name: string; description: string }[] = []): number {
  const q = query.toLowerCase();
  const tokens = searchTokens(query);
  const hay = `${server.name} ${server.title ?? ""} ${server.description} ${server.publisher ?? ""} ${server.categories.join(" ")}`.toLowerCase();
  const toolHay = extraTools.map((t) => `${t.name} ${t.description}`).join(" ").toLowerCase();
  let score = 0;
  if (server.name.toLowerCase() === q || (server.title ?? "").toLowerCase() === q) score += 100;
  if (hay.includes(q)) score += 40;
  for (const t of tokens) {
    if (hay.includes(t)) score += 12;
    if (toolHay.includes(t)) score += 16;
  }
  if (server.sources.includes("official")) score += 8;
  if (server.sources.includes("local") && server.installed) score += 20;
  if (server.trust.level === "verified") score += 10;
  else if (server.trust.level === "community") score += 4;
  if (server.trust.level === "blocked") score -= 1000;
  if (server.compatibility === "compatible") score += 3;
  return score;
}

export class RegistryAggregator {
  private cache = new Map<string, { at: number; payload: { results: RegistryResult[]; health: RegistryHealth[] } }>();
  private embedder = new HashingEmbedder(64);

  constructor(private providers: McpRegistryProvider[]) {}

  async health(): Promise<RegistryHealth[]> {
    return Promise.all(this.providers.map((p) => p.health().catch((err) => ({
      id: p.id,
      name: p.name,
      status: "offline" as const,
      detail: String(err?.message ?? err).slice(0, 160),
    }))));
  }

  async search(query: RegistrySearch): Promise<{ results: RegistryResult[]; health: RegistryHealth[]; degraded: string[] }> {
    const key = `${query.query}|${query.limit ?? 20}|${query.cursor ?? ""}|${query.category ?? ""}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { ...hit.payload, degraded: [] };
    }
    const term = primarySearchTerm(query.query);
    const officialQuery = { ...query, query: term };
    const health = await this.health();
    const degraded: string[] = [];
    const chunks = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const q = p.id === "official" ? officialQuery : query;
          return await p.search(q);
        } catch (err: any) {
          degraded.push(`${p.name}: ${String(err?.message ?? err).slice(0, 80)}`);
          return { results: [] };
        }
      })
    );
    const merged = new Map<string, RegistryResult>();
    for (const chunk of chunks) {
      for (const row of chunk.results) {
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
    const payload = { results: results.slice(0, query.limit ?? 24), health };
    this.cache.set(key, { at: Date.now(), payload });
    return { ...payload, degraded };
  }
}

function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}
