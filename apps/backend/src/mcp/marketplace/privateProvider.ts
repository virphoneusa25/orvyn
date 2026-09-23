import { inferCategories, trustFor } from "./classify";
import { normalizeOfficial } from "./officialProvider";
import { fetchCatalogJson, PROVIDER_TIMEOUTS_MS } from "./providerRuntime";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistrySearch } from "./types";

export interface PrivateRegistryConfig {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  authType?: "none" | "bearer";
  /** Secret is stored separately; only the header name lives here. */
  headerName?: string;
  timeoutMs?: number;
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
  const timeoutMs = cfg.timeoutMs ?? PROVIDER_TIMEOUTS_MS.private;
  return {
    id: "private",
    name: cfg.name,
    async health(): Promise<RegistryHealth> {
      if (!cfg.enabled) return { id: "private", name: cfg.name, status: "disabled", detail: "Turned off in settings" };
      try {
        await fetchCatalogJson({
          url: `${base}/v0.1/servers?limit=1&version=latest`,
          provider: "private",
          timeoutMs,
          headers: headers(),
          fetchImpl: fetchImpl as any,
        });
        return { id: "private", name: cfg.name, status: "online", detail: cfg.url };
      } catch (err: any) {
        return {
          id: "private",
          name: cfg.name,
          status: err?.errorClass === "timeout" ? "slow" : err?.errorClass === "auth-required" ? "auth-required" : "offline",
          detail: String(err?.message ?? err).slice(0, 160),
          errorClass: err?.errorClass,
        };
      }
    },
    async search(query: RegistrySearch) {
      if (!cfg.enabled) {
        return { results: [], health: { id: "private", name: cfg.name, status: "disabled", detail: "Turned off in settings" } };
      }
      const url = `${base}/v0.1/servers?search=${encodeURIComponent(query.query)}&version=latest&limit=${query.limit ?? 20}`;
      const { body } = await fetchCatalogJson({
        url,
        provider: "private",
        timeoutMs,
        headers: headers(),
        fetchImpl: fetchImpl as any,
      });
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
      try {
        const { body } = await fetchCatalogJson({
          url: `${base}/v0.1/servers/${encodeURIComponent(id)}/versions/latest`,
          provider: "private",
          timeoutMs,
          headers: headers(),
          fetchImpl: fetchImpl as any,
        });
        const server = normalizeOfficial(body);
        server.sources = ["private"];
        return server;
      } catch {
        return null;
      }
    },
  };
}
