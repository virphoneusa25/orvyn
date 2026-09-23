import { classifyMarketplaceRisk, inferCategories, trustFor } from "./classify";
import { fetchCatalogJson, PROVIDER_TIMEOUTS_MS } from "./providerRuntime";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistryResult, RegistrySearch } from "./types";
import { GLAMA_API_URL } from "./types";

export function glamaProvider(
  fetchImpl: typeof fetch = fetch,
  apiKey = process.env.GLAMA_API_KEY ?? ""
): McpRegistryProvider {
  return {
    id: "glama",
    name: "Glama",
    async health(): Promise<RegistryHealth> {
      if (!apiKey) {
        return {
          id: "glama",
          name: "Glama",
          status: "needs-key",
          detail: "Set GLAMA_API_KEY to federate Glama. Official Registry still works.",
        };
      }
      try {
        await fetchCatalogJson({
          url: `${GLAMA_API_URL}/v1/servers?first=1`,
          provider: "glama",
          timeoutMs: PROVIDER_TIMEOUTS_MS.glama,
          headers: { Authorization: `Bearer ${apiKey}` },
          fetchImpl: fetchImpl as any,
        });
        return { id: "glama", name: "Glama", status: "online", detail: "glama.ai · attribution required" };
      } catch (err: any) {
        return {
          id: "glama",
          name: "Glama",
          status: err?.errorClass === "timeout" ? "slow" : err?.errorClass === "auth-required" ? "auth-required" : "offline",
          detail: String(err?.message ?? err).slice(0, 160),
          errorClass: err?.errorClass,
        };
      }
    },
    async search(query: RegistrySearch) {
      if (!apiKey) {
        return {
          results: [],
          health: {
            id: "glama",
            name: "Glama",
            status: "needs-key",
            detail: "Set GLAMA_API_KEY to federate Glama. Official Registry still works.",
            errorClass: "needs-key",
          },
        };
      }
      const url = new URL(`${GLAMA_API_URL}/v1/servers`);
      if (query.query) url.searchParams.set("query", query.query);
      url.searchParams.set("first", String(Math.min(query.limit ?? 20, 50)));
      if (query.cursor) url.searchParams.set("after", query.cursor);
      const { body } = await fetchCatalogJson({
        url: url.toString(),
        provider: "glama",
        timeoutMs: PROVIDER_TIMEOUTS_MS.glama,
        headers: { Authorization: `Bearer ${apiKey}` },
        fetchImpl: fetchImpl as any,
      });
      const nodes = body.servers ?? body.data ?? body.edges?.map((e: any) => e.node) ?? [];
      const results: RegistryResult[] = (Array.isArray(nodes) ? nodes : []).map((n: any) => ({
        server: normalizeGlama(n),
        score: 0,
        matchedTools: (n.tools ?? []).slice(0, 6).map((t: any) => ({
          name: String(t.name ?? ""),
          description: String(t.description ?? ""),
          risk: classifyMarketplaceRisk(t.name ?? "", t.description ?? ""),
          origin: "declared" as const,
        })),
      }));
      return { results, cursor: body.pageInfo?.endCursor ?? body.endCursor };
    },
    async getServer(id: string) {
      if (!apiKey) return null;
      try {
        const { body } = await fetchCatalogJson({
          url: `${GLAMA_API_URL}/v1/servers/${id}`,
          provider: "glama",
          timeoutMs: PROVIDER_TIMEOUTS_MS.glama,
          headers: { Authorization: `Bearer ${apiKey}` },
          fetchImpl: fetchImpl as any,
        });
        return normalizeGlama(body);
      } catch {
        return null;
      }
    },
  };
}

export function normalizeGlama(n: any): MarketplaceMcpServer {
  const name = String(n.name ?? n.slug ?? "unknown");
  const description = String(n.description ?? "");
  const ns = n.namespace ? `${n.namespace}/${n.slug ?? name}` : name;
  const tools = (n.tools ?? []).map((t: any) => ({
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    risk: classifyMarketplaceRisk(t.name ?? "", t.description ?? ""),
  }));
  return {
    canonicalId: `glama:${n.id ?? ns}`,
    name: ns,
    title: name,
    description,
    publisher: n.namespace,
    sources: ["glama"],
    repository: n.repository?.url,
    homepage: n.url,
    iconUrl: n.iconUrl || n.image || n.logo || undefined,
    categories: inferCategories(name, description),
    packages: n.npmPackage ? [{ registry: "npm", identifier: String(n.npmPackage) }] : [],
    transports: n.url && String(n.url).startsWith("http") && !String(n.url).includes("glama.ai/mcp/servers")
      ? [{ kind: "http", url: String(n.url) }]
      : [{ kind: "stdio", command: "npx", args: ["-y", String(n.npmPackage ?? name)] }],
    tools: tools.map((t: { name: string; description: string; risk: ReturnType<typeof classifyMarketplaceRisk> }) => ({ ...t, origin: "declared" as const })),
    auth: [{ kind: "none", label: "See server listing" }],
    trust: trustFor({ sources: ["glama"], publisher: n.namespace, repository: n.repository?.url }),
    compatibility: "compatible",
    compatibilityReason: "Listed on Glama — confirm transport before install",
    toolCount: tools.length || n.toolCount,
    qualityNote: n.qualityScore != null ? `Glama quality signal: ${n.qualityScore} (attributed, not an ORVYN safety rating)` : undefined,
    license: n.spdxLicense,
    networkRequired: true,
    filesystemScope: "none",
  };
}
