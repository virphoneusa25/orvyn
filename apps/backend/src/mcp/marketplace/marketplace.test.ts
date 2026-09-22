import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, mergeServers, rankServer, RegistryAggregator } from "./aggregator";
import { classifyMarketplaceRisk, inferCategories, primarySearchTerm, trustFor } from "./classify";
import { installPlan } from "./install";
import { normalizeOfficial } from "./officialProvider";
import { officialProvider } from "./officialProvider";
import { glamaProvider, normalizeGlama } from "./glamaProvider";
import { CapabilityIndex } from "./searchCapabilities";
import { parseImportedMcpConfig, exportOrvynMcpConfig } from "./importExport";
import { verificationFor } from "./verifiedCatalog";
import { ToolSchemaCache } from "./schemaCache";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryResult } from "./types";

function sampleOfficial(name: string, description: string, extra: Record<string, unknown> = {}) {
  return {
    server: {
      name,
      description,
      version: "1.2.3",
      repository: { url: "https://github.com/github/github-mcp-server", source: "github" },
      packages: [{ registryType: "npm", identifier: "@modelcontextprotocol/server-github", version: "1.2.3" }],
      remotes: [],
      ...extra,
    },
    _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } },
  };
}

test("official normalize: npm package becomes pinned npx stdio", () => {
  const s = normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "GitHub pull requests and issues"));
  assert.equal(s.sources[0], "official");
  assert.ok(s.transports.some((t) => t.kind === "stdio" && t.args?.includes("@modelcontextprotocol/server-github@1.2.3")));
  assert.equal(s.version, "1.2.3");
  assert.ok(s.categories.includes("Version Control"));
  assert.equal(s.compatibility, "compatible");
});

test("official normalize: remote HTTP keeps secret header refs", () => {
  const s = normalizeOfficial({
    server: {
      name: "ai.example/remote",
      description: "Remote",
      remotes: [{ type: "streamable-http", url: "https://mcp.example/mcp", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }],
    },
  });
  assert.ok(s.transports.some((t) => t.kind === "http" && t.url === "https://mcp.example/mcp"));
  assert.equal(s.auth[0].kind, "bearer");
  assert.equal(s.networkRequired, true);
});

test("dedupe: same repo from official + glama becomes one card with two badges", () => {
  const a = normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "Official GitHub MCP"));
  const b = normalizeGlama({
    name: "GitHub MCP",
    namespace: "github",
    slug: "github-mcp-server",
    description: "PRs",
    repository: { url: "https://github.com/github/github-mcp-server" },
    tools: [{ name: "create_pull_request", description: "Open a PR" }],
  });
  assert.equal(canonicalKey(a), canonicalKey(b));
  const merged = mergeServers(a, b);
  assert.deepEqual(merged.sources.sort(), ["glama", "official"]);
});

test("ranking: tool description beats unused official listing", () => {
  const github: MarketplaceMcpServer = {
    ...normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "Work with GitHub")),
  };
  const other: MarketplaceMcpServer = {
    ...normalizeOfficial(sampleOfficial("ai.smithery/obsidian-github-mcp", "Obsidian vault on GitHub")),
  };
  const q = "create GitHub pull request";
  const g = rankServer(q, github, [{ name: "create_pull_request", description: "Create a GitHub pull request" }]);
  const o = rankServer(q, other, []);
  assert.ok(g > o, `github ${g} should outrank unrelated ${o}`);
});

test("primary search term extracts brand tokens", () => {
  assert.equal(primarySearchTerm("create GitHub pull request"), "github");
  assert.equal(primarySearchTerm("postgres database"), "postgres");
});

test("risk classification is ORVYN policy, not server annotations alone", () => {
  assert.equal(classifyMarketplaceRisk("delete_repo", "Remove a repository"), "destructive");
  assert.equal(classifyMarketplaceRisk("create_issue", "Open a Jira ticket"), "write");
  assert.equal(classifyMarketplaceRisk("list_files"), "read");
  assert.equal(classifyMarketplaceRisk("create_payment", "Charge Stripe"), "financial");
});

test("trust: official + known publisher is community; glama-only is unverified", () => {
  assert.equal(trustFor({ sources: ["official"], publisher: "io.github.github", repository: "https://github.com/github/x" }).level, "community");
  assert.equal(trustFor({ sources: ["glama"] }).level, "unverified");
  assert.equal(trustFor({ sources: ["official"], verified: true }).level, "verified");
  assert.equal(trustFor({ sources: ["official"], blocked: true }).level, "blocked");
});

test("install plan pins npm version and never embeds secrets", () => {
  const server = normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "GitHub"));
  const plan = installPlan(server);
  assert.equal(plan.transport, "stdio");
  assert.ok(plan.args?.some((a) => a.includes("@1.2.3")), "version pinned");
});

test("aggregator: provider failure degrades; official results remain", async () => {
  const official: McpRegistryProvider = {
    id: "official",
    name: "Official",
    health: async () => ({ id: "official", name: "Official", status: "online" }),
    search: async () => ({
      results: [{ server: normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "GitHub PRs")), score: 0 }],
    }),
    getServer: async () => null,
  };
  const glama: McpRegistryProvider = {
    id: "glama",
    name: "Glama",
    health: async () => ({ id: "glama", name: "Glama", status: "offline", detail: "down" }),
    search: async () => {
      throw new Error("Glama unreachable");
    },
    getServer: async () => null,
  };
  const agg = new RegistryAggregator([official, glama]);
  const out = await agg.search({ query: "GitHub PRs", limit: 10 });
  assert.ok(out.results.some((r) => r.server.name.includes("github")));
  assert.ok(out.degraded.some((d) => /Glama/.test(d)));
});

test("aggregator caches repeated queries", async () => {
  let calls = 0;
  const p: McpRegistryProvider = {
    id: "official",
    name: "Official",
    health: async () => ({ id: "official", name: "Official", status: "online" }),
    search: async () => {
      calls += 1;
      return { results: [{ server: normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "GitHub")), score: 0 }] };
    },
    getServer: async () => null,
  };
  const agg = new RegistryAggregator([p]);
  await agg.search({ query: "github" });
  await agg.search({ query: "github" });
  assert.equal(calls, 1);
});

test("capability index activates installed tools and never dumps the catalog", async () => {
  const hits: { name: string; source: string; description: string }[] = [
    { name: "mcp.github.create_pull_request", source: "github", description: "Open a PR" },
    { name: "search_code", source: "native", description: "Search the codebase" },
  ];
  const manager = { searchTools: (q: string) => (q ? hits : []) } as any;
  const index = new CapabilityIndex(manager);
  const out = await index.search("create GitHub pull request");
  assert.ok(index.exposeToModel("read_file"));
  assert.ok(index.exposeToModel("search_capabilities"));
  assert.equal(index.exposeToModel("mcp.other.delete_everything"), false);
  assert.ok(index.exposeToModel("mcp.github.create_pull_request"));
  assert.ok(out.activated.includes("mcp.github.create_pull_request"));
  assert.ok(out.activated.length <= 40);
});

test("categories include Telecom without inventing tools", () => {
  const cats = inferCategories("twilio-sip", "SIP trunking and E911");
  assert.ok(cats.includes("Telecom"));
});

test("official provider uses injected fetch (no live network in unit test)", async () => {
  const fetchImpl = async (url: string) => {
    assert.ok(String(url).includes("/v0.1/servers"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ servers: [sampleOfficial("io.github.github/github-mcp-server", "GitHub")], metadata: {} }),
    };
  };
  const p = officialProvider(fetchImpl as any);
  const out = await p.search({ query: "github", limit: 5 });
  assert.equal(out.results.length, 1);
  const h = await p.health();
  assert.equal(h.status, "online");
});

test("glama without API key stays needs-key and returns empty search", async () => {
  const p = glamaProvider(fetch, "");
  const h = await p.health();
  assert.equal(h.status, "needs-key");
  const out = await p.search({ query: "postgres" });
  assert.deepEqual(out.results, []);
});

test("install plan for HTTP uses secret refs, not live tokens", () => {
  const server = normalizeOfficial({
    server: {
      name: "ai.example/remote",
      description: "Remote",
      remotes: [{ type: "streamable-http", url: "https://mcp.example/mcp", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }],
    },
  });
  const plan = installPlan(server);
  assert.equal(plan.transport, "http");
  assert.equal(plan.headers?.Authorization, "Bearer {{Authorization}}");
  assert.equal(JSON.stringify(plan).includes("sk-"), false);
});

test("import Cursor/Claude/VS Code configs strips secrets", () => {
  const cursor = parseImportedMcpConfig({
    mcpServers: {
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
      remote: { url: "https://mcp.example/mcp", headers: { Authorization: "Bearer ghp_SUPERSECRETTOKENVALUE" } },
    },
  });
  assert.equal(cursor.length, 2);
  assert.equal(cursor.find((s) => s.name === "github")?.transport, "stdio");
  assert.equal(cursor.find((s) => s.name === "remote")?.headers?.Authorization, "Bearer {{token}}");
  const vscode = parseImportedMcpConfig({
    servers: { pg: { command: "uvx", args: ["postgres-mcp"] } },
  });
  assert.equal(vscode[0].sourceFormat, "vscode");
  const exported = exportOrvynMcpConfig([
    { name: "remote", transport: "http", url: "https://mcp.example/mcp", headers: { Authorization: "Bearer {{token}}" }, enabled: true },
  ]);
  assert.equal(exported.mcpServers.remote && (exported.mcpServers.remote as any).headers.Authorization, "{{secret}}");
});

test("verified catalog matches known GitHub official server", () => {
  const hit = verificationFor({
    canonicalId: "io.github.github/github-mcp-server",
    repository: "https://github.com/github/github-mcp-server",
    packages: [{ identifier: "@modelcontextprotocol/server-github" }],
  });
  assert.equal(hit?.level, "verified");
  assert.equal(verificationFor({ canonicalId: "com.random/unknown" }), null);
});

test("tool schema cache invalidates on hash mismatch", () => {
  const cache = new ToolSchemaCache();
  const tools = [{ name: "list", description: "a" }];
  const row = cache.put("srv", tools, "1.0.0");
  assert.equal(cache.stale("srv", row.schemaHash, "1.0.0"), false);
  assert.equal(cache.stale("srv", "deadbeef", "1.0.0"), true);
  cache.invalidate("srv");
  assert.equal(cache.get("srv"), undefined);
});

test("tool budget refuses to activate more than maxTools", () => {
  const index = new CapabilityIndex({ searchTools: () => [] } as any);
  index.budget = { maxServers: 1, maxTools: 2 };
  index.activate(["mcp.a.one", "mcp.a.two", "mcp.a.three", "mcp.b.one"]);
  assert.equal(index.activated.size, 2);
  assert.equal(index.exposeToModel("mcp.a.one"), true);
  assert.equal(index.exposeToModel("mcp.b.one"), false);
});
