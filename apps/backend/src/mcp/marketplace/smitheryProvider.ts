import { classifyMarketplaceRisk, inferCategories, trustFor } from "./classify";
import { fetchCatalogJson, PROVIDER_TIMEOUTS_MS } from "./providerRuntime";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistryResult, RegistrySearch } from "./types";
import { SMITHERY_API_URL } from "./types";

export function smitheryProvider(
  fetchImpl: typeof fetch = fetch,
  apiKey = process.env.SMITHERY_API_KEY ?? ""
): McpRegistryProvider {
  return {
    id: "smithery",
    name: "Smithery",
    async health(): Promise<RegistryHealth> {
      if (!apiKey) {
        return {
          id: "smithery",
          name: "Smithery",
          status: "needs-key",
          detail: "Set SMITHERY_API_KEY or mcp.secret.smithery for Smithery discovery.",
        };
      }
      try {
        const { status } = await fetchCatalogJson({
          url: `${SMITHERY_API_URL}/servers?q=&pageSize=1`,
          provider: "smithery",
          timeoutMs: PROVIDER_TIMEOUTS_MS.smithery,
          headers: { Authorization: `Bearer ${apiKey}` },
          fetchImpl: fetchImpl as any,
        });
        return { id: "smithery", name: "Smithery", status: "online", detail: `smithery.ai · HTTP ${status}` };
      } catch (err: any) {
        const status = err?.errorClass === "auth-required" || err?.errorClass === "permission-denied" ? "auth-required"
          : err?.errorClass === "rate-limited" ? "rate-limited"
          : err?.errorClass === "timeout" ? "slow"
          : "offline";
        return { id: "smithery", name: "Smithery", status, detail: String(err?.message ?? err).slice(0, 160) };
      }
    },
    async search(query: RegistrySearch) {
      if (!apiKey) {
        return {
          results: [],
          health: {
            id: "smithery",
            name: "Smithery",
            status: "needs-key",
            detail: "Set SMITHERY_API_KEY or mcp.secret.smithery for Smithery discovery.",
            errorClass: "needs-key",
          },
        };
      }
      const pageSize = Math.min(Math.max(query.limit ?? 20, 1), 50);
      const url = new URL(`${SMITHERY_API_URL}/servers`);
      url.searchParams.set("q", query.query.trim());
      url.searchParams.set("pageSize", String(pageSize));
      if (query.cursor) url.searchParams.set("page", String(query.cursor));
      const { body } = await fetchCatalogJson({
        url: url.toString(),
        provider: "smithery",
        timeoutMs: PROVIDER_TIMEOUTS_MS.smithery,
        headers: { Authorization: `Bearer ${apiKey}` },
        fetchImpl: fetchImpl as any,
      });
      const rows = Array.isArray(body.servers) ? body.servers : Array.isArray(body.result) ? body.result : [];
      const results: RegistryResult[] = rows.map((n: any) => ({
        server: normalizeSmithery(n),
        score: 0,
        matchedTools: toolsOf(n).slice(0, 6),
      }));
      const next = body.pagination?.currentPage != null && body.pagination?.totalPages > body.pagination.currentPage
        ? String(Number(body.pagination.currentPage) + 1)
        : undefined;
      return { results, cursor: next };
    },
    async getServer(id: string) {
      if (!apiKey) return null;
      try {
        const { body } = await fetchCatalogJson({
          url: `${SMITHERY_API_URL}/servers/${encodeURIComponent(id)}`,
          provider: "smithery",
          timeoutMs: PROVIDER_TIMEOUTS_MS.smithery,
          headers: { Authorization: `Bearer ${apiKey}` },
          fetchImpl: fetchImpl as any,
        });
        return normalizeSmithery(body.server ?? body);
      } catch {
        return null;
      }
    },
  };
}

export function normalizeSmithery(n: any): MarketplaceMcpServer {
  const qualified = String(n.qualifiedName ?? n.qualified_name ?? n.id ?? n.name ?? "unknown");
  const title = String(n.displayName ?? n.display_name ?? n.title ?? qualified.split("/").pop() ?? qualified);
  const description = String(n.description ?? "");
  const repo = n.repository?.url ?? n.repository ?? n.repoUrl;
  const homepage = n.homepage ?? n.url ?? n.remoteUrl;
  const tools = toolsOf(n);
  const remoteUrl = n.remote && typeof n.connections?.[0]?.url === "string" ? n.connections[0].url : undefined;
  const npm = n.npmPackage ?? n.packageName ?? (qualified.includes("/") ? undefined : qualified);
  return {
    canonicalId: `smithery:${qualified}`,
    name: qualified,
    title,
    description,
    publisher: qualified.includes("/") ? qualified.split("/")[0] : n.owner,
    sources: ["smithery"],
    repository: repo ? String(repo) : undefined,
    homepage: homepage ? String(homepage) : undefined,
    iconUrl: n.iconUrl || n.icon || undefined,
    categories: inferCategories(title, description),
    packages: npm ? [{ registry: "npm", identifier: String(npm) }] : [],
    remotes: remoteUrl ? [{ url: String(remoteUrl) }] : [],
    transports: remoteUrl
      ? [{ kind: "http", url: String(remoteUrl) }]
      : npm
        ? [{ kind: "stdio", command: "npx", args: ["-y", String(npm)] }]
        : [],
    tools,
    auth: [{ kind: "none", label: "See Smithery listing" }],
    trust: trustFor({ sources: ["smithery"], publisher: qualified, repository: repo }),
    compatibility: remoteUrl || npm ? "compatible" : "limited",
    compatibilityReason: "Listed on Smithery — confirm transport before install",
    toolCount: tools.length || (typeof n.toolCount === "number" ? n.toolCount : undefined),
    networkRequired: Boolean(remoteUrl),
    filesystemScope: "none",
    executionLocation: remoteUrl ? "remote" : "local",
  };
}

function toolsOf(n: any): MarketplaceMcpServer["tools"] {
  const raw = Array.isArray(n.tools) ? n.tools : Array.isArray(n.toolsList) ? n.toolsList : [];
  return raw
    .map((t: any) => ({
      name: String(t.name ?? t.id ?? "").trim(),
      description: String(t.description ?? ""),
      risk: classifyMarketplaceRisk(t.name ?? "", t.description ?? ""),
      origin: "declared" as const,
    }))
    .filter((t: { name: string }) => t.name);
}
