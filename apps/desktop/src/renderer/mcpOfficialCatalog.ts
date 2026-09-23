// Desktop-side Official MCP Registry client. Used when Cloud Mode's
// control plane does not serve /mcp/marketplace (HTML / 404 / missing route).
// Discovery may fall back here. Install still goes through ORVYN MCP APIs.

import type { MarketServer } from "./mcpMarketplaceModel.ts";
import { parseApiJson, type ParsedApi } from "./mcpMarketplaceIcons.ts";

export const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io";
export const CANONICAL_GITHUB_QUERY = "github-mcp-server";

export type CatalogState = "cloud" | "official-fallback" | "degraded" | "auth-required" | "offline" | "error";

export interface CatalogDecision {
  state: CatalogState;
  useOfficialFallback: boolean;
  markUnsupported: boolean;
  reason?: string;
}

const unsupportedHosts = new Map<string, boolean>();

export function marketplaceHostKey(backendUrl: string): string {
  try {
    return new URL(backendUrl).host.toLowerCase();
  } catch {
    return backendUrl.replace(/\/$/, "").toLowerCase();
  }
}

export function isMarketplaceUnsupported(backendUrl: string): boolean {
  return unsupportedHosts.get(marketplaceHostKey(backendUrl)) === true;
}

export function markMarketplaceUnsupported(backendUrl: string): void {
  unsupportedHosts.set(marketplaceHostKey(backendUrl), true);
}

export function resetMarketplaceSupport(backendUrl?: string): void {
  if (!backendUrl) unsupportedHosts.clear();
  else unsupportedHosts.delete(marketplaceHostKey(backendUrl));
}

export function decideCatalogSource(input: {
  status: number;
  parsed: Pick<ParsedApi, "ok" | "kind" | "marketplaceRouteUnsupported">;
  catalogCount: number;
  cachedUnsupported?: boolean;
}): CatalogDecision {
  if (input.cachedUnsupported) {
    return { state: "official-fallback", useOfficialFallback: true, markUnsupported: true, reason: "cached-unsupported" };
  }
  if (input.status === 401 || input.status === 403) {
    return { state: "auth-required", useOfficialFallback: true, markUnsupported: false, reason: String(input.status) };
  }
  if (input.status === 0) {
    return { state: "offline", useOfficialFallback: true, markUnsupported: false };
  }
  if (input.parsed.marketplaceRouteUnsupported || input.parsed.kind === "html" || input.status === 404) {
    return { state: "official-fallback", useOfficialFallback: true, markUnsupported: true, reason: "unsupported-route" };
  }
  if (input.parsed.ok) {
    return { state: "cloud", useOfficialFallback: false, markUnsupported: false };
  }
  if (input.status >= 500) {
    return { state: "degraded", useOfficialFallback: true, markUnsupported: false, reason: `HTTP ${input.status}` };
  }
  return { state: "error", useOfficialFallback: true, markUnsupported: false };
}

/** @deprecated prefer decideCatalogSource — kept so 5601966 call sites stay explicit. */
export function shouldUseOfficialFallback(
  controlPlaneOk: boolean,
  catalogCount: number,
  status = 200,
  html = false
): boolean {
  return decideCatalogSource({
    status,
    parsed: {
      ok: controlPlaneOk,
      kind: html ? "html" : controlPlaneOk ? "json" : "non-json",
      marketplaceRouteUnsupported: html || status === 404,
    },
    catalogCount,
  }).useOfficialFallback;
}

export function isFirstPartyOfficialMarketServer(server: Pick<MarketServer, "name" | "title" | "canonicalId" | "publisher" | "repository" | "packages" | "sources" | "installed">): boolean {
  const id = `${server.canonicalId ?? ""} ${server.name ?? ""}`.toLowerCase();
  const repo = `${server.repository ?? ""}`.toLowerCase();
  const publisher = `${server.publisher ?? ""}`.toLowerCase();
  if ((server.sources ?? []).some((s) => s === "local" || s === "private")) return true;
  if (server.installed) return true;
  if (id.includes("io.modelcontextprotocol/") || publisher === "io.modelcontextprotocol") return true;
  if ((server.packages ?? []).some((p) => /^(?:@modelcontextprotocol\/server-(?:filesystem|memory|everything|sequential-thinking)|mcp-server-(?:git|fetch|time))$/.test(p.identifier))) return true;
  if (publisher === "io.github.github" || /io\.github\.github\/github-mcp-server/i.test(id)) return true;
  if (/github\.com\/github\/github-mcp-server/i.test(repo) || /github\.com\/modelcontextprotocol\//i.test(repo)) return true;
  return false;
}

export function officialMarketplaceOnly(servers: MarketServer[]): MarketServer[] {
  return servers.filter((s) => isFirstPartyOfficialMarketServer(s));
}

export function isProductGithub(server: Pick<MarketServer, "name" | "title" | "repository">): boolean {
  if (/io\.github\.github\/github-mcp-server/i.test(server.name)) return true;
  if (/github\.com\/github\/github-mcp-server/i.test(server.repository ?? "")) return true;
  const title = (server.title ?? "").trim();
  return /^(github|github mcp)$/i.test(title) && /github\.com\/github\//i.test(server.repository ?? "");
}

export function rankOfficialServer(query: string, server: MarketServer): number {
  const q = query.trim().toLowerCase();
  let score = 0;
  if (isProductGithub(server) && (!q || /github/.test(q))) score += 120;
  if (server.name.toLowerCase() === "io.github.github/github-mcp-server") score += 80;
  if (/github\.com\/github\/github-mcp-server/i.test(server.repository ?? "")) score += 50;
  if ((server.publisher ?? "").toLowerCase() === "io.github.github") score += 25;
  if (/io\.modelcontextprotocol\//i.test(server.name) && (!q || /javascript|typescript|\bjs\b|python|node|filesystem|fetch|git|memory|time|official/.test(q))) {
    score += 400;
  }
  if (q && server.name.toLowerCase().includes(q)) score += 10;
  if (q && (server.title ?? "").toLowerCase() === q) score += 20;
  if (q && /postgres/.test(q) && /postgres/.test(`${server.name} ${server.title ?? ""}`)) {
    score += /postgresql-mcp|postgres\/postgres/i.test(server.name) ? 40 : 15;
  }
  return score;
}

export function rankOfficialResults(query: string, servers: MarketServer[]): MarketServer[] {
  return [...servers].sort((a, b) => rankOfficialServer(query, b) - rankOfficialServer(query, a));
}

/** Extra Official Registry queries that fill a sparse first page. Empty
 *  browse must not collapse to GitHub-only — users were seeing a handful of
 *  wrappers and thinking the catalog was the whole MCP ecosystem. */
export const BROWSE_SEED_QUERIES = [
  CANONICAL_GITHUB_QUERY,
  "filesystem",
  "postgres",
  "sqlite",
  "slack",
  "fetch",
  "playwright",
  "browser",
  "memory",
  "git",
  "docker",
  "sentry",
] as const;

export function supplementQueries(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...BROWSE_SEED_QUERIES];
  if (q === "github" || q === "github mcp") return [CANONICAL_GITHUB_QUERY];
  if (q === "postgres" || q === "postgresql") return ["postgresql-mcp-server", "postgres"];
  if (q === "file" || q === "files" || q === "fs") return ["filesystem"];
  if (q === "browser" || q === "chrome") return ["playwright", "browser"];
  if (q === "js" || q === "javascript" || q === "typescript" || q === "node" || q === "nodejs") {
    return ["javascript", "typescript", "nodejs"];
  }
  if (q === "python" || q === "py") return ["python", "mcp-server-git", "mcp-server-fetch"];
  return [];
}

const JS_TERMS = new Set(["js", "javascript", "typescript", "ts", "node", "nodejs"]);
const PY_TERMS = new Set(["python", "py", "pypi", "uvx"]);
const SEARCH_META = new Set(["official", "mcp", "server", "servers", "tool", "tools", "registry", "catalog", "marketplace"]);

export const OFFICIAL_REFERENCE_SEEDS: Array<{
  name: string;
  title: string;
  description: string;
  language: "typescript" | "python";
  identifier: string;
  version: string;
  registry: "npm" | "pypi";
}> = [
  { name: "io.modelcontextprotocol/filesystem", title: "Filesystem", description: "Official JavaScript / TypeScript MCP reference server for secure file operations.", language: "typescript", identifier: "@modelcontextprotocol/server-filesystem", version: "2026.8.31", registry: "npm" },
  { name: "io.modelcontextprotocol/memory", title: "Memory", description: "Official JavaScript / TypeScript MCP reference server that stores a knowledge graph.", language: "typescript", identifier: "@modelcontextprotocol/server-memory", version: "2026.8.31", registry: "npm" },
  { name: "io.modelcontextprotocol/everything", title: "Everything", description: "Official JavaScript / TypeScript MCP reference server that exercises prompts, resources, and tools.", language: "typescript", identifier: "@modelcontextprotocol/server-everything", version: "2026.8.31", registry: "npm" },
  { name: "io.modelcontextprotocol/sequential-thinking", title: "Sequential Thinking", description: "Official JavaScript / TypeScript MCP reference server for step-by-step problem solving.", language: "typescript", identifier: "@modelcontextprotocol/server-sequential-thinking", version: "2026.8.31", registry: "npm" },
  { name: "io.modelcontextprotocol/git", title: "Git", description: "Official Python MCP reference server for Git repositories.", language: "python", identifier: "mcp-server-git", version: "2026.8.18", registry: "pypi" },
  { name: "io.modelcontextprotocol/fetch", title: "Fetch", description: "Official Python MCP reference server for fetching web content.", language: "python", identifier: "mcp-server-fetch", version: "2026.8.18", registry: "pypi" },
  { name: "io.modelcontextprotocol/time", title: "Time", description: "Official Python MCP reference server for time and timezones.", language: "python", identifier: "mcp-server-time", version: "2026.8.18", registry: "pypi" },
];

export function officialReferenceMarketServers(query: string): MarketServer[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !SEARCH_META.has(t));
  const specs = !tokens.length
    ? OFFICIAL_REFERENCE_SEEDS
    : OFFICIAL_REFERENCE_SEEDS.filter((spec) => {
        if (tokens.some((t) => JS_TERMS.has(t)) && spec.language === "typescript") return true;
        if (tokens.some((t) => PY_TERMS.has(t)) && spec.language === "python") return true;
        return tokens.some((t) => `${spec.name} ${spec.title} ${spec.identifier}`.toLowerCase().includes(t));
      });
  return specs.map((spec) => {
    const npm = spec.registry === "npm";
    return {
      canonicalId: spec.name,
      name: spec.name,
      title: spec.title,
      description: spec.description,
      publisher: "io.modelcontextprotocol",
      sources: ["official"],
      repository: "https://github.com/modelcontextprotocol/servers",
      homepage: "https://modelcontextprotocol.io/examples",
      categories: spec.language === "python" ? ["Version Control", "Developer Tools"] : ["Developer Tools"],
      packages: [{ registry: spec.registry, identifier: spec.identifier, version: spec.version }],
      transports: [{ kind: "stdio", command: npm ? "npx" : "uvx", args: npm ? ["-y", `${spec.identifier}@${spec.version}`] : [spec.identifier] }],
      tools: [],
      auth: [{ kind: "none", label: "No auth advertised" }],
      trust: { level: "verified", reasons: ["Official MCP reference server"] },
      compatibility: "compatible",
      version: spec.version,
      networkRequired: spec.name.endsWith("/fetch"),
    } satisfies MarketServer;
  });
}

export function normalizeOfficialRow(row: any): MarketServer {
  const server = row?.server ?? row ?? {};
  const name = String(server.name ?? server.title ?? "unknown");
  const description = String(server.description ?? "");
  const packages = (server.packages ?? []).map((p: any) => ({
    registry: mapRegistry(p.registryType ?? p.registry),
    identifier: String(p.identifier ?? p.name ?? ""),
    version: p.version ? String(p.version) : undefined,
  }));
  const transports: MarketServer["transports"] = [];
  for (const r of server.remotes ?? []) {
    if (r?.url) transports.push({ kind: "http", url: String(r.url) });
  }
  for (const p of server.packages ?? []) {
    const ident = String(p.identifier ?? p.name ?? "");
    if (!ident) continue;
    const registry = mapRegistry(p.registryType ?? p.registry);
    transports.push({
      kind: "stdio",
      command: registry === "pypi" || registry === "uvx" ? "uvx" : "npx",
      args: registry === "pypi" || registry === "uvx" ? [ident] : ["-y", p.version ? `${ident}@${p.version}` : ident],
    });
  }
  const repository = server.repository?.url ? String(server.repository.url) : undefined;
  const homepage = server.websiteUrl ? String(server.websiteUrl) : repository;
  const officialTools = extractOfficialTools(server);
  return {
    canonicalId: name,
    name,
    title: server.title ? String(server.title) : undefined,
    description,
    publisher: name.includes("/") ? name.split("/")[0] : undefined,
    sources: ["official"],
    repository,
    homepage,
    iconUrl: firstPublishedIcon(server),
    categories: inferCategories(name, description),
    packages,
    transports,
    tools: officialTools,
    toolCount: officialTools.length || undefined,
    auth: transports.some((t) => t.kind === "http")
      ? [{ kind: "bearer", label: "Bearer token" }]
      : [{ kind: "none", label: "No auth advertised" }],
    trust: { level: "community", reasons: ["Official MCP Registry"] },
    compatibility: transports.length ? "compatible" : "unsupported",
    compatibilityReason: transports.length ? undefined : "No stdio or Streamable HTTP transport advertised",
    version: server.version ? String(server.version) : undefined,
    license: server.license ? String(server.license) : undefined,
    networkRequired: transports.some((t) => t.kind === "http") || /http|api|cloud|remote|network/i.test(description),
    filesystemScope: /workspace|project|cwd/i.test(`${name} ${description}`)
      ? "project"
      : /file|folder|path/i.test(`${name} ${description}`)
        ? "selected"
        : "none",
  };
}

export function dedupeServers(servers: MarketServer[]): MarketServer[] {
  const seen = new Set<string>();
  const out: MarketServer[] = [];
  for (const s of servers) {
    const repo = (s.repository ?? "").toLowerCase().replace(/\.git$/, "").replace(/\/+$/, "");
    const pkg = (s.packages?.[0]?.identifier ?? "").toLowerCase();
    const monorepo = /github\.com\/modelcontextprotocol\/servers$/i.test(repo);
    const key = (pkg && (monorepo || !repo) ? `pkg:${pkg}` : repo || s.canonicalId || s.name).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function preferKnownProducts(servers: MarketServer[]): MarketServer[] {
  return rankOfficialResults("", servers);
}

export function serversFromOfficialBody(body: unknown): MarketServer[] {
  const rows = Array.isArray((body as { servers?: unknown })?.servers) ? (body as { servers: unknown[] }).servers : [];
  return rows.map((row) => normalizeOfficialRow(row));
}

export function officialNextCursor(body: unknown): string | undefined {
  const cursor = (body as { metadata?: { nextCursor?: unknown } })?.metadata?.nextCursor;
  return typeof cursor === "string" && cursor.trim() ? cursor.trim() : undefined;
}

export type OfficialFetch = (
  query: string,
  limit: number,
  cursor?: string
) => Promise<{ ok: boolean; body: unknown; error?: string }>;

export async function searchOfficialRegistry(
  query: string,
  limit = 48,
  fetchOfficial?: OfficialFetch,
  pages = 1
): Promise<MarketServer[]> {
  const impl = fetchOfficial ?? defaultOfficialFetch;
  const collected: MarketServer[] = [];
  let cursor: string | undefined;
  const maxPages = query.trim() ? Math.max(1, pages) : Math.max(2, pages);
  for (let page = 0; page < maxPages; page++) {
    const res = await impl(query, limit, cursor);
    if (!res.ok) {
      if (page === 0 && !collected.length) {
        const err = new Error(res.error || "Official registry unavailable");
        (err as Error & { catalogPartial?: boolean }).catalogPartial = true;
        throw err;
      }
      break;
    }
    collected.push(...serversFromOfficialBody(res.body));
    cursor = officialNextCursor(res.body);
    const foundCanonical = query.trim() && collected.some((s) => rankOfficialServer(query, s) >= 80);
    if (!cursor || foundCanonical) break;
  }
  return rankOfficialResults(query, dedupeServers(collected));
}

export async function loadOfficialFallbackCatalog(
  query: string,
  fetchOfficial?: OfficialFetch
): Promise<MarketServer[]> {
  const seeds = officialReferenceMarketServers(query);
  let primary: MarketServer[] = [];
  try {
    primary = await searchOfficialRegistry(query, 48, fetchOfficial, query.trim() ? 1 : 3);
  } catch {
    if (!seeds.length) throw new Error("Official registry unavailable");
  }
  const extras: MarketServer[] = [];
  for (const term of supplementQueries(query)) {
    if (term === query.trim()) continue;
    try {
      extras.push(...(await searchOfficialRegistry(term, 16, fetchOfficial)));
    } catch {
      /* keep whatever we already have */
    }
  }
  return officialMarketplaceOnly(rankOfficialResults(query, dedupeServers([...seeds, ...extras, ...primary])));
}

export async function resolveMarketplaceCatalog(input: {
  status: number;
  text: string;
  contentType?: string;
  query: string;
  backendUrl: string;
  loadOfficial?: (query: string) => Promise<MarketServer[]>;
  previousCatalog?: MarketServer[];
}): Promise<{
  state: CatalogState;
  catalog: MarketServer[];
  notice?: string;
  error?: string;
  parsed: ParsedApi;
  fromCache?: boolean;
  degraded?: boolean;
}> {
  const parsed = parseApiJson(input.status, input.text, input.contentType);
  const cloudCatalog: MarketServer[] = officialMarketplaceOnly(
    parsed.ok
      ? ((parsed.body?.results ?? []).map((r: { server: MarketServer }) => r.server).filter(Boolean) as MarketServer[])
      : []
  );
  const cloudDegraded = Boolean(parsed.ok && (parsed.body?.degradedFlag || (Array.isArray(parsed.body?.degraded) && parsed.body.degraded.length)));
  const decision = decideCatalogSource({
    status: input.status,
    parsed,
    catalogCount: cloudCatalog.length,
    cachedUnsupported: isMarketplaceUnsupported(input.backendUrl),
  });
  if (decision.markUnsupported) markMarketplaceUnsupported(input.backendUrl);

  if (decision.state === "cloud") {
    return {
      state: "cloud",
      catalog: cloudCatalog,
      parsed,
      degraded: cloudDegraded,
      notice: cloudDegraded
        ? Array.isArray(parsed.body?.degraded) && parsed.body.degraded.length
          ? parsed.body.degraded[0]
          : "Some registries are unavailable"
        : undefined,
    };
  }

  const authNotice =
    decision.state === "auth-required"
      ? parsed.error || "Cloud account/session requires attention"
      : undefined;

  if (!decision.useOfficialFallback) {
    return {
      state: decision.state,
      catalog: cloudCatalog.length ? cloudCatalog : input.previousCatalog ?? [],
      parsed,
      error: authNotice || parsed.error || `HTTP ${input.status}`,
      degraded: true,
    };
  }

  try {
    const official = officialMarketplaceOnly(await (input.loadOfficial ?? loadOfficialFallbackCatalog)(input.query));
    const merged = officialMarketplaceOnly(dedupeServers([...official, ...cloudCatalog]));
    if (merged.length) {
      return {
        state: decision.state === "auth-required" ? "auth-required" : "official-fallback",
        catalog: merged,
        parsed,
        notice:
          decision.state === "auth-required"
            ? "Cloud account/session requires attention. Showing public registry discovery."
            : decision.state === "offline"
              ? "Offline · showing cached catalog"
              : "Cloud catalog unavailable · showing Official Registry results",
        error: authNotice,
        degraded: true,
      };
    }
    const kept = input.previousCatalog ?? [];
    return {
      state: kept.length ? "degraded" : "degraded",
      catalog: kept,
      parsed,
      fromCache: kept.length > 0,
      degraded: true,
      notice: kept.length ? "Some registries are unavailable" : undefined,
      error: kept.length ? undefined : "Official MCP Registry returned no servers.",
    };
  } catch (err: any) {
    const message = /aborted|timeout/i.test(String(err?.message))
      ? "Official Registry is responding slowly."
      : /Unexpected token/.test(String(err?.message))
        ? "A registry returned an incompatible response."
        : err?.message || "Official MCP Registry unavailable";
    const kept = cloudCatalog.length ? cloudCatalog : input.previousCatalog ?? [];
    return {
      state: kept.length ? "degraded" : "degraded",
      catalog: kept,
      parsed,
      fromCache: !cloudCatalog.length && kept.length > 0,
      degraded: true,
      notice: kept.length ? `${message} Showing results from available sources.` : "Marketplace is temporarily offline.",
      error: kept.length ? undefined : message,
    };
  }
}

export function installPayload(server: MarketServer, secrets?: Record<string, string>) {
  const http = server.transports.find((t) => t.kind === "http" && t.url);
  const stdio = server.transports.find((t) => t.kind === "stdio" && t.command);
  const name = server.title || server.name.split("/").pop() || server.name;
  if (http?.url) {
    return {
      name,
      transport: "http" as const,
      url: http.url,
      description: server.description.slice(0, 180),
      secrets,
    };
  }
  if (stdio) {
    return {
      name,
      transport: "stdio" as const,
      command: stdio.command,
      args: stdio.args,
      description: server.description.slice(0, 180),
      env: secrets,
    };
  }
  throw new Error("This server has no supported install transport (need stdio or Streamable HTTP).");
}

export function shouldUseHostInstall(parsed: Pick<ParsedApi, "marketplaceRouteUnsupported" | "ok">, status: number): boolean {
  if (status === 401 || status === 403) return false;
  return parsed.marketplaceRouteUnsupported || status === 404;
}

async function defaultOfficialFetch(query: string, limit: number, cursor?: string): Promise<{ ok: boolean; body: unknown; error?: string }> {
  const ipc = (globalThis as { window?: { orvyn?: { marketplace?: { officialSearch?: (q: string, n?: number, c?: string) => Promise<{ ok: boolean; body: unknown; error?: string }> } } } }).window
    ?.orvyn?.marketplace?.officialSearch;
  if (ipc) return ipc(query, limit, cursor);
  const params = new URLSearchParams({ version: "latest", limit: String(limit) });
  if (query.trim()) params.set("search", query.trim());
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${OFFICIAL_REGISTRY_URL}/v0.1/servers?${params}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  const text = await res.text();
  if (text.trim().startsWith("<") || /text\/html/i.test(res.headers.get("content-type") ?? "")) {
    return { ok: false, body: {}, error: `Official registry returned HTML (HTTP ${res.status})` };
  }
  try {
    const body = text.trim() ? JSON.parse(text) : {};
    return { ok: res.ok, body, error: res.ok ? undefined : body?.error || `Official registry HTTP ${res.status}` };
  } catch {
    return { ok: false, body: {}, error: `Official registry returned non-JSON (HTTP ${res.status})` };
  }
}

function firstPublishedIcon(server: any): string | undefined {
  const icons = Array.isArray(server?.icons) ? server.icons : [];
  for (const icon of icons) {
    const src = String(icon?.src ?? icon?.url ?? "");
    if (/^https:\/\//i.test(src)) return src;
  }
  return undefined;
}

function mapRegistry(raw: string | undefined): NonNullable<MarketServer["packages"]>[number]["registry"] {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("pypi") || v.includes("python")) return "pypi";
  if (v.includes("docker") || v.includes("oci")) return "docker";
  if (v.includes("nuget") || v.includes("binary")) return "binary";
  return "npm";
}

function extractOfficialTools(server: any): NonNullable<MarketServer["tools"]> {
  const raw = Array.isArray(server?.tools)
    ? server.tools
    : Array.isArray(server?._meta?.tools)
      ? server._meta.tools
      : [];
  const out: NonNullable<MarketServer["tools"]> = [];
  for (const t of raw) {
    const name = String(t?.name ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      description: String(t?.description ?? ""),
      risk: String(t?.annotations?.destructiveHint ? "destructive" : t?.annotations?.readOnlyHint ? "read" : "external-side-effect"),
    });
  }
  return out;
}

function inferCategories(name: string, description: string): string[] {
  const text = `${name} ${description}`;
  const hits: string[] = [];
  if (/git|github|gitlab|pull.?request|commit/i.test(text)) hits.push("Version Control");
  if (/postgres|mysql|sqlite|mongo|redis|sql|database/i.test(text)) hits.push("Databases");
  if (/slack|discord|teams|chat/i.test(text)) hits.push("Communication");
  if (/email|smtp|imap|gmail/i.test(text)) hits.push("Email");
  if (/aws|azure|gcp|cloudflare|vercel/i.test(text)) hits.push("Cloud");
  if (/docker|container/i.test(text)) hits.push("Containers");
  return hits.length ? [...new Set(hits)].slice(0, 4) : ["Developer Tools"];
}
