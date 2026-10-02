import { LOCAL_BACKEND_URL, apiUrl, authHeaders, getConnectionConfig, isCloudBackend } from "./connection.ts";
import type { MarketServer } from "./mcpMarketplaceModel.ts";
import { installPayload, shouldUseHostInstall } from "./mcpOfficialCatalog.ts";
import type { ParsedApi } from "./mcpMarketplaceIcons.ts";

/** A server the user can install without a platform API key or directory token. */
export function serverRequiresUserSecret(server: Pick<MarketServer, "auth" | "transports">): boolean {
  const auth = server.auth ?? [];
  if (auth.some((a) => ["oauth", "bearer", "api_key", "custom"].includes(a.kind))) return true;
  return (server.transports ?? []).some((t) => t.kind === "http" && /secret|token|key/i.test(JSON.stringify(t)));
}

export function isPublicFreeMcp(server: Pick<MarketServer, "auth" | "transports" | "sources" | "name" | "packages">): boolean {
  if (serverRequiresUserSecret(server)) return false;
  if ((server.sources ?? []).includes("official")) return true;
  if ((server.packages ?? []).some((p) => /^@modelcontextprotocol\/|^mcp-server-(git|fetch|time)$/.test(p.identifier))) {
    return true;
  }
  return (server.transports ?? []).some((t) => t.kind === "stdio" || (t.kind === "http" && t.url));
}

export function publicInstallSteps(server: Pick<MarketServer, "auth" | "transports">): string[] {
  return serverRequiresUserSecret(server)
    ? ["Review", "Permissions", "Authentication", "Confirm", "Done"]
    : ["Review", "Permissions", "Confirm", "Done"];
}

export const GITHUB_MCP_HTTP = "https://api.githubcopilot.com/mcp/";

export function isOfficialGithubMcp(server: { name: string; canonicalId?: string; repository?: string; packages?: { identifier: string }[] }): boolean {
  const blob = `${server.canonicalId ?? ""} ${server.name} ${server.repository ?? ""} ${(server.packages ?? []).map((p) => p.identifier).join(" ")}`;
  return /io\.github\.github\/github-mcp|github\.com\/github\/github-mcp-server|@modelcontextprotocol\/server-github/i.test(blob);
}

export function isStdioOnlyMcp(server: Pick<MarketServer, "transports">): boolean {
  const transports = server.transports ?? [];
  return transports.some((t) => t.kind === "stdio") && !transports.some((t) => t.kind === "http" && t.url);
}

/** Cloud cannot spawn npx stdio. Desktop stdio (Fetch, GitHub, Memory) still installs here. GitHub HTTP+OAuth is Cloud-only when there is no stdio package. */
export function prepareMarketplaceInstall(server: MarketServer, backendIsCloud = currentBackendIsCloud()): MarketServer {
  if (isOfficialGithubMcp(server)) {
    const hasHttp = (server.transports ?? []).some((t) => t.kind === "http" && t.url);
    const hasStdio = (server.transports ?? []).some((t) => t.kind === "stdio");
    const auth = server.auth.some((a) => a.kind === "oauth" || a.kind === "api_key" || a.kind === "bearer")
      ? server.auth
      : backendIsCloud && !hasStdio
        ? [{ kind: "oauth" as const, label: "GitHub" }]
        : [{ kind: "api_key" as const, label: "GITHUB_PERSONAL_ACCESS_TOKEN" }];
    return {
      ...server,
      transports:
        backendIsCloud && !hasHttp && !hasStdio ? [{ kind: "http", url: GITHUB_MCP_HTTP }, ...server.transports] : server.transports,
      auth,
    };
  }
  return server;
}

export function shouldInstallOnLocalEngine(
  server: Pick<MarketServer, "auth" | "transports" | "sources" | "name" | "packages">,
  backendIsCloud: boolean
): boolean {
  if (!backendIsCloud) return false;
  if ((server.transports ?? []).some((t) => t.kind === "stdio")) return true;
  if (isOfficialGithubMcp(server) && (server.transports ?? []).some((t) => t.kind === "http" && t.url) && !(server.transports ?? []).some((t) => t.kind === "stdio")) {
    return false;
  }
  return isPublicFreeMcp(server) || isStdioOnlyMcp(server);
}

export function marketplaceSecrets(server: Pick<MarketServer, "name" | "canonicalId" | "packages">, secrets?: Record<string, string>): Record<string, string> | undefined {
  if (!secrets || !Object.keys(secrets).length) return undefined;
  const out = { ...secrets };
  const token = out.GITHUB_PERSONAL_ACCESS_TOKEN || out.token || out.TOKEN;
  if (token && isOfficialGithubMcp(server)) out.GITHUB_PERSONAL_ACCESS_TOKEN = token;
  return out;
}

export function shouldUseLocalPublicInstall(input: {
  status: number;
  parsed: Pick<ParsedApi, "marketplaceRouteUnsupported" | "ok">;
  server: Pick<MarketServer, "auth" | "transports" | "sources" | "name" | "packages">;
  hasPlatformKey: boolean;
  backendIsCloud: boolean;
}): boolean {
  if (shouldInstallOnLocalEngine(input.server, input.backendIsCloud)) return true;
  if (isPublicFreeMcp(input.server) && (input.backendIsCloud || !input.hasPlatformKey || input.status === 401 || input.status === 403)) {
    return true;
  }
  return shouldUseHostInstall(input.parsed, input.status);
}

export type McpActionHost = "local" | "control";

export function mcpActionHost(server?: Pick<MarketServer, "transports" | "installed"> | null, extra?: { host?: McpActionHost; executionLocation?: string; transport?: string }): McpActionHost {
  if (extra?.host === "local" || extra?.host === "control") return extra.host;
  if (server?.installed?.host === "local") return "local";
  if (server?.installed?.host === "control") return "control";
  if (extra?.executionLocation === "local" || extra?.transport === "stdio") {
    return currentBackendIsCloud() ? "local" : "control";
  }
  if (server && currentBackendIsCloud() && (isStdioOnlyMcp(server) || (server.transports ?? []).some((t) => t.kind === "stdio"))) {
    return "local";
  }
  return "control";
}

export async function runMcpServerAction(
  id: string,
  action: "connect" | "disconnect" | "reconnect" | "delete",
  host: McpActionHost
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (host === "local") {
    const ready = await ensureLocalMarketplaceEngine();
    if (!ready) return { ok: false, error: "Local ORVYN engine is not running. Start it to install or enable desktop MCP tools." };
  }
  const path = action === "delete" ? `/mcp/servers/${id}` : `/mcp/servers/${id}/${action}`;
  const req = mcpActionRequest(path, host);
  try {
    const res = await fetch(req.url, { method: action === "delete" ? "DELETE" : "POST", headers: req.headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: String(body.error || `MCP ${action} failed (HTTP ${res.status})`) };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export function mcpActionRequest(path: string, host: McpActionHost): { url: string; headers: Record<string, string> } {
  if (host === "local") {
    return { url: localMarketplaceUrl(path), headers: { "Content-Type": "application/json" } };
  }
  return { url: apiUrl(path), headers: { "Content-Type": "application/json", ...authHeaders() } };
}

export function localMarketplaceUrl(path: string): string {
  return `${LOCAL_BACKEND_URL.replace(/\/$/, "")}/api/v1${path}`;
}

export async function ensureLocalMarketplaceEngine(): Promise<boolean> {
  const ensure = (globalThis as { window?: { orvyn?: { engine?: { ensureLocal?: () => Promise<{ ok: boolean }> } } } }).window
    ?.orvyn?.engine?.ensureLocal;
  if (ensure) {
    const out = await ensure().catch(() => ({ ok: false }));
    return Boolean(out?.ok);
  }
  try {
    const res = await fetch(`${LOCAL_BACKEND_URL.replace(/\/$/, "")}/api/v1/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function installPublicMcpOnLocalHost(
  server: MarketServer,
  secrets?: Record<string, string>,
  cwd?: string
): Promise<{ ok: true; serverId?: string } | { ok: false; error: string }> {
  const ready = await ensureLocalMarketplaceEngine();
  if (!ready) {
    return { ok: false, error: "Local ORVYN engine is not running. Public MCP tools install on this desktop — no API key is required." };
  }
  const payloadSecrets = serverRequiresUserSecret(server) ? marketplaceSecrets(server, secrets) : undefined;
  try {
    const res = await fetch(localMarketplaceUrl("/mcp/marketplace/install"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, secrets: payloadSecrets, connect: true, cwd, preferStdio: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok || res.status === 201) return { ok: true, serverId: typeof body.server === "string" ? body.server : body.server?.id };
    if (res.status === 404 || /html/i.test(String(body.error ?? ""))) {
      const host = await fetch(localMarketplaceUrl("/mcp/servers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(installPayload(server, payloadSecrets)),
      });
      const created = await host.json().catch(() => ({}));
      if (!host.ok) return { ok: false, error: created.error || "Local install failed" };
      const id = created.server?.id;
      if (id) {
        await fetch(localMarketplaceUrl(`/mcp/servers/${id}/connect`), { method: "POST", headers: { "Content-Type": "application/json" } }).catch(
          () => undefined
        );
      }
      return { ok: true, serverId: id };
    }
    return { ok: false, error: body.error || `Install failed (HTTP ${res.status})` };
  } catch (err: any) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

export interface McpStatusRow {
  id: string;
  name: string;
  state?: string;
  enabled?: boolean;
  toolCount?: number;
  lastConnectedAt?: number;
  host?: McpActionHost;
  marketplaceId?: string;
  packageIdentifier?: string;
  [key: string]: unknown;
}

export function mergeMcpStatusLists(...lists: McpStatusRow[][]): McpStatusRow[] {
  const rank = (state?: string) => (state === "CONNECTED" ? 3 : state === "ERROR" || state === "NEEDS_AUTH" ? 2 : state === "CONNECTING" ? 1 : 0);
  const byId = new Map<string, McpStatusRow>();
  for (const list of lists) {
    for (const row of list) {
      if (!row?.id) continue;
      const prev = byId.get(row.id);
      if (!prev || rank(row.state) >= rank(prev.state)) byId.set(row.id, row);
    }
  }
  return [...byId.values()];
}

function tagHost(rows: McpStatusRow[], host: McpActionHost): McpStatusRow[] {
  return rows.map((row) => ({ ...row, host: row.host ?? host }));
}

async function readStatusList(url: string, headers?: Record<string, string>): Promise<McpStatusRow[]> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) });
    const body = await res.json().catch(() => ({}));
    return Array.isArray(body?.servers) ? (body.servers as McpStatusRow[]) : [];
  } catch {
    return [];
  }
}

/** Cloud Mode installs public MCP on the local engine — Installed must read both. */
export async function fetchInstalledMcpStatuses(controlPlane?: McpStatusRow[]): Promise<McpStatusRow[]> {
  const control = tagHost(controlPlane ?? (await readStatusList(apiUrl("/mcp/statuses"), authHeaders())), "control");
  if (!currentBackendIsCloud()) return control;
  await ensureLocalMarketplaceEngine();
  const local = tagHost(await readStatusList(localMarketplaceUrl("/mcp/statuses")), "local");
  return mergeMcpStatusLists(control, local);
}

export function currentBackendIsCloud(): boolean {
  return isCloudBackend(getConnectionConfig().backendUrl);
}

export function hasPlatformKey(): boolean {
  return Boolean(getConnectionConfig().apiKey?.trim());
}
