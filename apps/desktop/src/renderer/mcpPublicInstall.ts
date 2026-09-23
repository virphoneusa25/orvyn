import { LOCAL_BACKEND_URL, getConnectionConfig, isCloudBackend } from "./connection.ts";
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

export function shouldUseLocalPublicInstall(input: {
  status: number;
  parsed: Pick<ParsedApi, "marketplaceRouteUnsupported" | "ok">;
  server: Pick<MarketServer, "auth" | "transports" | "sources" | "name" | "packages">;
  hasPlatformKey: boolean;
  backendIsCloud: boolean;
}): boolean {
  if (isPublicFreeMcp(input.server) && (input.backendIsCloud || !input.hasPlatformKey || input.status === 401 || input.status === 403)) {
    return true;
  }
  return shouldUseHostInstall(input.parsed, input.status);
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
  const payloadSecrets = serverRequiresUserSecret(server) ? secrets : undefined;
  try {
    const res = await fetch(localMarketplaceUrl("/mcp/marketplace/install"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, secrets: payloadSecrets, connect: true, cwd }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok || res.status === 201) return { ok: true, serverId: body.server };
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

export function currentBackendIsCloud(): boolean {
  return isCloudBackend(getConnectionConfig().backendUrl);
}

export function hasPlatformKey(): boolean {
  return Boolean(getConnectionConfig().apiKey?.trim());
}
