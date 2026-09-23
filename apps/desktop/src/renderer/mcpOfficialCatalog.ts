// Desktop-side Official MCP Registry client. Used when Cloud Mode's
// control plane returns HTML/404/empty for /mcp/marketplace so the
// Marketplace still looks like Local Mode (real servers + logos).

import type { MarketServer } from "./mcpMarketplaceModel.ts";

export const OFFICIAL_REGISTRY_URL = "https://registry.modelcontextprotocol.io";

export function shouldUseOfficialFallback(controlPlaneOk: boolean, catalogCount: number): boolean {
  return !controlPlaneOk || catalogCount === 0;
}

export function isProductGithub(server: Pick<MarketServer, "name" | "title">): boolean {
  if (/io\.github\.github\/github-mcp|github\/github-mcp-server/i.test(server.name)) return true;
  const title = (server.title ?? "").trim();
  return /^(github|github mcp)$/i.test(title);
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
  const rank = (s: MarketServer) => {
    if (isProductGithub(s)) return 0;
    const text = `${s.title ?? ""} ${s.name}`.toLowerCase();
    if (/postgres/.test(text)) return 1;
    if (/^slack|\/slack/.test(text)) return 2;
    return 3;
  };
  return [...servers].sort((a, b) => rank(a) - rank(b));
}

export function serversFromOfficialBody(body: unknown): MarketServer[] {
  const rows = Array.isArray((body as { servers?: unknown })?.servers) ? (body as { servers: unknown[] }).servers : [];
  return rows.map((row) => normalizeOfficialRow(row));
}

export async function searchOfficialRegistry(
  query: string,
  limit = 24,
  fetchOfficial?: (query: string, limit: number) => Promise<{ ok: boolean; body: unknown; error?: string }>
): Promise<MarketServer[]> {
  const impl = fetchOfficial ?? defaultOfficialFetch;
  const res = await impl(query, limit);
  if (!res.ok) throw new Error(res.error || "Official registry unavailable");
  return serversFromOfficialBody(res.body);
}

export async function loadOfficialFallbackCatalog(
  query: string,
  fetchOfficial?: (query: string, limit: number) => Promise<{ ok: boolean; body: unknown; error?: string }>
): Promise<MarketServer[]> {
  const primary = await searchOfficialRegistry(query, 24, fetchOfficial);
  if (query.trim()) return preferKnownProducts(primary);
  const extras: MarketServer[] = [];
  for (const term of primary.some(isProductGithub) ? [] : ["github-mcp-server", "postgres"]) {
    try {
      extras.push(...(await searchOfficialRegistry(term, 8, fetchOfficial)));
    } catch {
      /* keep whatever we already have */
    }
  }
  return preferKnownProducts(dedupeServers([...extras, ...primary]));
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

async function defaultOfficialFetch(query: string, limit: number): Promise<{ ok: boolean; body: unknown; error?: string }> {
  const ipc = (globalThis as { window?: { orvyn?: { marketplace?: { officialSearch?: (q: string, n?: number) => Promise<{ ok: boolean; body: unknown; error?: string }> } } } }).window?.orvyn
    ?.marketplace?.officialSearch;
  if (ipc) return ipc(query, limit);
  const params = new URLSearchParams({ version: "latest", limit: String(limit) });
  if (query.trim()) params.set("search", query.trim());
  const res = await fetch(`${OFFICIAL_REGISTRY_URL}/v0.1/servers?${params}`, { headers: { Accept: "application/json" } });
  const text = await res.text();
  if (text.trim().startsWith("<")) return { ok: false, body: {}, error: `Official registry returned HTML (HTTP ${res.status})` };
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
