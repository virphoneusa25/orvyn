import { classifyMarketplaceRisk, inferCategories, trustFor } from "./classify";
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
        const res = await fetchImpl(`${GLAMA_API_URL}/v1/servers?first=1`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        return {
          id: "glama",
          name: "Glama",
          status: res.ok ? "online" : "offline",
          detail: res.ok ? "glama.ai · attribution required" : `HTTP ${res.status}`,
        };
      } catch (err: any) {
        return { id: "glama", name: "Glama", status: "offline", detail: String(err?.message ?? err).slice(0, 160) };
      }
    },
    async search(query: RegistrySearch) {
      if (!apiKey) return { results: [] };
      const url = new URL(`${GLAMA_API_URL}/v1/servers`);
      if (query.query) url.searchParams.set("query", query.query);
      url.searchParams.set("first", String(Math.min(query.limit ?? 20, 50)));
      if (query.cursor) url.searchParams.set("after", query.cursor);
      const res = await fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) throw new Error(`Glama HTTP ${res.status}`);
      const body = await res.json();
      const nodes = body.servers ?? body.data ?? body.edges?.map((e: any) => e.node) ?? [];
      const results: RegistryResult[] = (Array.isArray(nodes) ? nodes : []).map((n: any) => ({
        server: normalizeGlama(n),
        score: 0,
        matchedTools: (n.tools ?? []).slice(0, 6).map((t: any) => ({
          name: String(t.name ?? ""),
          description: String(t.description ?? ""),
          risk: classifyMarketplaceRisk(t.name ?? "", t.description ?? ""),
        })),
      }));
      return { results, cursor: body.pageInfo?.endCursor ?? body.endCursor };
    },
    async getServer(id: string) {
      if (!apiKey) return null;
      const res = await fetchImpl(`${GLAMA_API_URL}/v1/servers/${id}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (!res.ok) return null;
      return normalizeGlama(await res.json());
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
    categories: inferCategories(name, description),
    packages: n.npmPackage ? [{ registry: "npm", identifier: String(n.npmPackage) }] : [],
    transports: n.url && String(n.url).startsWith("http") && !String(n.url).includes("glama.ai/mcp/servers")
      ? [{ kind: "http", url: String(n.url) }]
      : [{ kind: "stdio", command: "npx", args: ["-y", String(n.npmPackage ?? name)] }],
    tools,
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
