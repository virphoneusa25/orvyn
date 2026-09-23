import {
  compatibilityOf,
  filesystemScope,
  inferCategories,
  networkRequired,
  trustFor,
} from "./classify";
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
  (url: string): Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;
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
        const res = await fetchImpl(`${baseUrl}/v0.1/servers?limit=1&version=latest`);
        return {
          id: "official",
          name: "Official MCP Registry",
          status: res.ok ? "online" : "offline",
          detail: res.ok ? "registry.modelcontextprotocol.io" : `HTTP ${res.status}`,
        };
      } catch (err: any) {
        return { id: "official", name: "Official MCP Registry", status: "offline", detail: String(err?.message ?? err).slice(0, 160) };
      }
    },
    async search(query: RegistrySearch) {
      const term = encodeURIComponent(query.query.trim());
      const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
      const cursor = query.cursor ? `&cursor=${encodeURIComponent(query.cursor)}` : "";
      const search = query.query.trim() ? `search=${term}&` : "";
      const url = `${baseUrl}/v0.1/servers?${search}version=latest&limit=${limit}${cursor}`;
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`Official registry HTTP ${res.status}`);
      const body = await res.json();
      const rows = Array.isArray(body.servers) ? body.servers : [];
      const results: RegistryResult[] = rows.map((row: any) => ({
        server: normalizeOfficial(row),
        score: 0,
      }));
      return { results, cursor: body.metadata?.nextCursor };
    },
    async getServer(id: string) {
      const encoded = encodeURIComponent(id);
      const res = await fetchImpl(`${baseUrl}/v0.1/servers/${encoded}/versions/latest`);
      if (!res.ok) return null;
      return normalizeOfficial(await res.json());
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
    tools: [],
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

function mapRegistry(raw: string | undefined): McpPackage["registry"] {
  const v = String(raw ?? "").toLowerCase();
  if (v.includes("pypi") || v.includes("python")) return "pypi";
  if (v.includes("docker")) return "docker";
  if (v.includes("nuget") || v.includes("binary")) return "binary";
  if (v.includes("oci")) return "docker";
  return "npm";
}
