import {
  compatibilityOf,
  filesystemScope,
  inferCategories,
  networkRequired,
  trustFor,
} from "./classify";
import { fetchCatalogJson, PROVIDER_TIMEOUTS_MS } from "./providerRuntime";
import type {
  MarketplaceMcpServer,
  McpPackage,
  McpRegistryProvider,
  McpTransportDescriptor,
  RegistryHealth,
  RegistryResult,
  RegistrySearch,
} from "./types";
import { OFFICIAL_REGISTRY_URL } from "./types";

export interface OfficialFetch {
  (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<any>;
    text?: () => Promise<string>;
    headers?: { get(name: string): string | null };
  }>;
}

export function officialProvider(
  fetchImpl: OfficialFetch = fetch as OfficialFetch,
  baseUrl = OFFICIAL_REGISTRY_URL
): McpRegistryProvider {
  return {
    id: "official",
    name: "Official MCP Registry",
    async health(): Promise<RegistryHealth> {
      try {
        await fetchCatalogJson({
          url: `${baseUrl}/v0.1/servers?limit=1&version=latest`,
          provider: "official",
          timeoutMs: PROVIDER_TIMEOUTS_MS.official,
          fetchImpl,
        });
        return { id: "official", name: "Official MCP Registry", status: "online", detail: "registry.modelcontextprotocol.io" };
      } catch (err: any) {
        return {
          id: "official",
          name: "Official MCP Registry",
          status: err?.errorClass === "timeout" ? "slow" : "offline",
          detail: String(err?.message ?? err).slice(0, 160),
          errorClass: err?.errorClass,
        };
      }
    },
    async search(query: RegistrySearch) {
      const term = encodeURIComponent(query.query.trim());
      const limit = Math.min(Math.max(query.limit ?? 48, 1), 100);
      const search = query.query.trim() ? `search=${term}&` : "";
      const pages = query.cursor || query.query.trim() ? 1 : 3;
      const results: RegistryResult[] = [];
      let cursor = query.cursor ? String(query.cursor) : "";
      let lastCursor: string | undefined;
      const started = Date.now();
      const seen = new Set<string>();
      for (let page = 0; page < pages; page++) {
        const remaining = PROVIDER_TIMEOUTS_MS.official - (Date.now() - started);
        if (remaining < 250) break;
        const cursorQs = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
        const url = `${baseUrl}/v0.1/servers?${search}version=latest&limit=${limit}${cursorQs}`;
        const { body } = await fetchCatalogJson({
          url,
          provider: "official",
          timeoutMs: remaining,
          fetchImpl,
          retry: page === 0,
        });
        const rows = Array.isArray(body.servers) ? body.servers : [];
        for (const row of rows) {
          const server = normalizeOfficial(row);
          if (seen.has(server.canonicalId)) continue;
          seen.add(server.canonicalId);
          results.push({ server, score: 0 });
        }
        lastCursor = body.metadata?.nextCursor;
        if (!lastCursor) break;
        cursor = String(lastCursor);
      }
      for (const extra of supplementOfficialQueries(query.query)) {
        const remaining = PROVIDER_TIMEOUTS_MS.official - (Date.now() - started);
        if (remaining < 250) break;
        try {
          const { body } = await fetchCatalogJson({
            url: `${baseUrl}/v0.1/servers?search=${encodeURIComponent(extra)}&version=latest&limit=16`,
            provider: "official",
            timeoutMs: Math.min(remaining, 4000),
            fetchImpl,
            retry: false,
          });
          for (const row of Array.isArray(body.servers) ? body.servers : []) {
            const server = normalizeOfficial(row);
            if (seen.has(server.canonicalId)) continue;
            seen.add(server.canonicalId);
            results.push({ server, score: 0 });
          }
        } catch {
          /* supplement is best-effort; primary page already counts */
        }
      }
      return { results, cursor: lastCursor };
    },
    async getServer(id: string) {
      try {
        const encoded = encodeURIComponent(id);
        const { body } = await fetchCatalogJson({
          url: `${baseUrl}/v0.1/servers/${encoded}/versions/latest`,
          provider: "official",
          timeoutMs: PROVIDER_TIMEOUTS_MS.official,
          fetchImpl,
        });
        return normalizeOfficial(body);
      } catch {
        return null;
      }
    },
  };
}

export function normalizeOfficial(row: any): MarketplaceMcpServer {
  const server = row?.server ?? row ?? {};
  const meta = row?._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
  const name = String(server.name ?? server.title ?? "unknown");
  const description = String(server.description ?? "");
  const packages: McpPackage[] = (server.packages ?? []).map((p: any) => ({
    registry: mapRegistry(p.registryType ?? p.registry),
    identifier: String(p.identifier ?? p.name ?? ""),
    version: p.version ? String(p.version) : undefined,
    transportHint: "stdio" as const,
  }));
  const transports: McpTransportDescriptor[] = [];
  for (const r of server.remotes ?? []) {
    transports.push({
      kind: "http",
      url: String(r.url ?? ""),
      headers: (r.headers ?? []).map((h: any) => ({
        name: String(h.name ?? "Authorization"),
        secret: Boolean(h.isSecret),
        required: Boolean(h.isRequired),
      })),
    });
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
  const officialTools = extractOfficialTools(server) ?? [];
  const draft: MarketplaceMcpServer = {
    canonicalId: name,
    name,
    title: server.title,
    description,
    publisher: name.includes("/") ? name.split("/")[0] : undefined,
    sources: ["official"],
    repository: server.repository?.url,
    homepage: server.websiteUrl ?? server.repository?.url,
    iconUrl: firstPublishedIcon(server) ?? githubOwnerAvatar(server.repository?.url ?? server.websiteUrl),
    categories: inferCategories(name, description),
    packages,
    transports,
    remotes: transports.filter((t) => t.kind === "http" && t.url).map((t) => ({ url: t.url! })),
    tools: officialTools.map((t) => ({ ...t, origin: "declared" as const })),
    executionLocation: transports.some((t) => t.kind === "http") ? "remote" : "local",
    toolCount: officialTools.length || undefined,
    auth: transports.some((t) => t.headers?.some((h) => h.secret))
      ? [{ kind: "bearer", label: "Bearer token" }]
      : [{ kind: "none", label: "No auth advertised" }],
    trust: trustFor({ sources: ["official"], publisher: name, repository: server.repository?.url }),
    compatibility: "compatible",
    version: server.version,
    license: server.license,
    networkRequired: false,
    filesystemScope: filesystemScope(`${name} ${description}`),
  };
  const compat = compatibilityOf(draft);
  draft.compatibility = compat.compatibility;
  draft.compatibilityReason = compat.reason;
  draft.networkRequired = networkRequired(draft);
  draft.trust = trustFor({
    sources: ["official"],
    publisher: draft.publisher,
    repository: draft.repository,
    verified: meta.status === "active" && /modelcontextprotocol|github\.com\/github/i.test(`${draft.publisher} ${draft.repository}`),
  });
  return draft;
}

function extractOfficialTools(server: any): MarketplaceMcpServer["tools"] {
  const raw = Array.isArray(server?.tools)
    ? server.tools
    : Array.isArray(server?._meta?.tools)
      ? server._meta.tools
      : [];
  const out: NonNullable<MarketplaceMcpServer["tools"]> = [];
  for (const t of raw) {
    const name = String(t?.name ?? "").trim();
    if (!name) continue;
    out.push({
      name,
      description: String(t?.description ?? ""),
      risk: t?.annotations?.destructiveHint ? "destructive" : t?.annotations?.readOnlyHint ? "read" : "external-side-effect",
    });
  }
  return out;
}

function firstPublishedIcon(server: any): string | undefined {
  const icons = Array.isArray(server?.icons) ? server.icons : [];
  for (const icon of icons) {
    const src = String(icon?.src ?? icon?.url ?? "");
    if (/^https?:\/\//i.test(src)) return src;
  }
  return undefined;
}

function githubOwnerAvatar(url?: string): string | undefined {
  if (!url) return undefined;
  const m = String(url).match(/github\.com\/+([^/?#]+)\/+([^/?#]+)/i);
  if (!m) return undefined;
  const owner = m[1];
  if (!owner || /^(topics|orgs|settings|marketplace)$/i.test(owner)) return undefined;
  return `https://github.com/${owner}.png?size=80`;
}

export function supplementOfficialQueries(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return ["github-mcp-server", "filesystem", "postgres", "slack"];
  if (q === "github" || q === "github mcp") return ["github-mcp-server"];
  if (q === "postgres" || q === "postgresql") return ["postgresql-mcp-server"];
  if (q === "js" || q === "javascript") return ["javascript", "nodejs"];
  return [];
}

function mapRegistry(raw: string | undefined): McpPackage["registry"] {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("pypi") || v.includes("python")) return "pypi";
  if (v.includes("docker")) return "docker";
  if (v.includes("nuget") || v.includes("binary")) return "binary";
  if (v.includes("oci")) return "docker";
  return "npm";
}
