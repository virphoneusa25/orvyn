import { inferCategories, trustFor } from "./classify";
import { normalizeOfficial } from "./officialProvider";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistrySearch } from "./types";

export interface PrivateRegistryConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authType?: "none" | "bearer";
  /** Secret is stored separately; only the header name lives here. */
  headerName?: string;
}

export function privateProvider(
  cfg: PrivateRegistryConfig,
  fetchImpl: typeof fetch = fetch,
  getToken?: () => string | null
): McpRegistryProvider {
  const headers = (): Record<string, string> => {
    const token = getToken?.();
    if (cfg.authType === "bearer" && token) return { Authorization: `Bearer ${token}` };
    return {};
  };
  const base = cfg.url.replace(/\/$/, "");
  return {
    id: "private",
    name: cfg.name,
    async health(): Promise<RegistryHealth> {
      if (!cfg.enabled) return { id: "private", name: cfg.name, status: "disabled", detail: "Turned off in settings" };
      try {
        const res = await fetchImpl(`${base}/v0.1/servers?limit=1&version=latest`, { headers: headers() });
        return { id: "private", name: cfg.name, status: res.ok ? "online" : "offline", detail: res.ok ? cfg.url : `HTTP ${res.status}` };
      } catch (err: any) {
        return { id: "private", name: cfg.name, status: "offline", detail: String(err?.message ?? err).slice(0, 160) };
      }
    },
    async search(query: RegistrySearch) {
      if (!cfg.enabled) return { results: [] };
      const url = `${base}/v0.1/servers?search=${encodeURIComponent(query.query)}&version=latest&limit=${query.limit ?? 20}`;
      const res = await fetchImpl(url, { headers: headers() });
      if (!res.ok) throw new Error(`${cfg.name} HTTP ${res.status}`);
      const body = await res.json();
      return {
        results: (body.servers ?? []).map((row: any) => {
          const server = normalizeOfficial(row);
          server.sources = ["private"];
          server.trust = trustFor({ sources: ["private"], publisher: server.publisher, repository: server.repository });
          server.categories = inferCategories(server.name, server.description);
          return { server, score: 0 };
        }),
        cursor: body.metadata?.nextCursor,
      };
    },
    async getServer(id: string): Promise<MarketplaceMcpServer | null> {
      if (!cfg.enabled) return null;
      const res = await fetchImpl(`${base}/v0.1/servers/${encodeURIComponent(id)}/versions/latest`, { headers: headers() });
      if (!res.ok) return null;
      const server = normalizeOfficial(await res.json());
      server.sources = ["private"];
      return server;
    },
  };
}
