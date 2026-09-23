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
    return { state: "auth-required", useOfficialFallback: false, markUnsupported: false, reason: String(input.status) };
  }
  if (input.status === 0) {
    return { state: "offline", useOfficialFallback: false, markUnsupported: false };
  }
  if (input.parsed.marketplaceRouteUnsupported || input.parsed.kind === "html" || input.status === 404) {
    return { state: "official-fallback", useOfficialFallback: true, markUnsupported: true, reason: "unsupported-route" };
  }
  if (input.parsed.ok) {
    return { state: "cloud", useOfficialFallback: false, markUnsupported: false };
  }
  return { state: "error", useOfficialFallback: false, markUnsupported: false };
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

export function supplementQueries(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return [CANONICAL_GITHUB_QUERY];
  if (q === "github" || q === "github mcp") return [CANONICAL_GITHUB_QUERY];
  if (q === "postgres" || q === "postgresql") return ["postgresql-mcp-server", "postgres"];
  return [];
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
    tools: [],
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
    const key = (s.repository || s.canonicalId || s.name).toLowerCase();
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
  limit = 24,
  fetchOfficial?: OfficialFetch
): Promise<MarketServer[]> {
  const impl = fetchOfficial ?? defaultOfficialFetch;
  const res = await impl(query, limit);
  if (!res.ok) throw new Error(res.error || "Official registry unavailable");
  const first = serversFromOfficialBody(res.body);
  const cursor = officialNextCursor(res.body);
  if (!cursor || first.some((s) => rankOfficialServer(query, s) >= 80)) return rankOfficialResults(query, first);
  const more = await impl(query, limit, cursor);
  if (!more.ok) return rankOfficialResults(query, first);
  return rankOfficialResults(query, dedupeServers([...first, ...serversFromOfficialBody(more.body)]));
}

export async function loadOfficialFallbackCatalog(
  query: string,
  fetchOfficial?: OfficialFetch
): Promise<MarketServer[]> {
  const primary = await searchOfficialRegistry(query, 24, fetchOfficial);
  const extras: MarketServer[] = [];
  for (const term of supplementQueries(query)) {
    if (term === query.trim()) continue;
    try {
      extras.push(...(await searchOfficialRegistry(term, 8, fetchOfficial)));
    } catch {
      /* keep whatever we already have */
    }
  }
  return rankOfficialResults(query, dedupeServers([...extras, ...primary]));
}

export async function resolveMarketplaceCatalog(input: {
  status: number;
  text: string;
  contentType?: string;
  query: string;
  backendUrl: string;
  loadOfficial?: (query: string) => Promise<MarketServer[]>;
}): Promise<{
  state: CatalogState;
  catalog: MarketServer[];
  notice?: string;
  error?: string;
  parsed: ParsedApi;
}> {
  const parsed = parseApiJson(input.status, input.text, input.contentType);
  const cloudCatalog: MarketServer[] = parsed.ok
    ? ((parsed.body?.results ?? []).map((r: { server: MarketServer }) => r.server).filter(Boolean) as MarketServer[])
    : [];
  const decision = decideCatalogSource({
    status: input.status,
    parsed,
    catalogCount: cloudCatalog.length,
    cachedUnsupported: isMarketplaceUnsupported(input.backendUrl),
  });
  if (decision.markUnsupported) markMarketplaceUnsupported(input.backendUrl);

  if (decision.state === "auth-required") {
    return {
      state: "auth-required",
      catalog: [],
      parsed,
      error: parsed.error || "Marketplace needs a signed-in control plane session.",
    };
  }
  if (decision.state === "offline") {
    return { state: "offline", catalog: [], parsed, error: parsed.error || "Marketplace is offline." };
  }
  if (decision.state === "error") {
    return { state: "error", catalog: cloudCatalog, parsed, error: parsed.error || `HTTP ${input.status}` };
  }
  if (decision.state === "cloud") {
    return { state: "cloud", catalog: cloudCatalog, parsed };
  }

  try {
    const official = await (input.loadOfficial ?? loadOfficialFallbackCatalog)(input.query);
    if (official.length) {
      return {
        state: "official-fallback",
        catalog: official,
        parsed,
        notice: "Cloud catalog unavailable · showing Official Registry results",
      };
    }
    return { state: "degraded", catalog: [], parsed, error: "Official MCP Registry returned no servers." };
  } catch (err: any) {
    return {
      state: "degraded",
      catalog: [],
      parsed,
      error: err?.message || "Official MCP Registry unavailable",
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
    signal: AbortSignal.timeout(8000),
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
