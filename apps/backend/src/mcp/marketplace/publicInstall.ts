import type { MarketplaceMcpServer } from "./types";

export function serverRequiresUserSecret(server: Pick<MarketplaceMcpServer, "auth" | "transports">): boolean {
  if ((server.auth ?? []).some((a) => ["oauth", "bearer", "api_key", "custom"].includes(a.kind))) return true;
  return (server.transports ?? []).some((t) => (t.headers ?? []).some((h) => h.secret || h.required));
}

/** Official / public MCP servers install without a platform or directory API key. */
export function isPublicFreeMcp(server: Pick<MarketplaceMcpServer, "auth" | "transports" | "sources" | "packages" | "name">): boolean {
  if (serverRequiresUserSecret(server)) return false;
  if ((server.sources ?? []).includes("official")) return true;
  const pkgs = (server.packages ?? []).map((p) => p.identifier.toLowerCase());
  if (pkgs.some((p) => p.startsWith("@modelcontextprotocol/") || /^mcp-server-(git|fetch|time)$/.test(p))) return true;
  return /io\.modelcontextprotocol\//i.test(server.name ?? "");
}
