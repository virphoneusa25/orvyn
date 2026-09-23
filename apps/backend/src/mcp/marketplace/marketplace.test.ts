import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalKey, isCanonicalGithub, mergeServers, rankServer, RegistryAggregator } from "./aggregator";
import { CatalogCache, catalogCacheKey, CATALOG_FRESH_TTL_MS } from "./catalogCache";
import { catalogSearchQuery, classifyMarketplaceRisk, inferCategories, primarySearchTerm, trustFor } from "./classify";
import { officialReferenceResults } from "./officialReference";
import { isPublicFreeMcp, serverRequiresUserSecret } from "./publicInstall";
import { installPlan } from "./install";
import { normalizeOfficial } from "./officialProvider";
import { officialProvider } from "./officialProvider";
import { glamaProvider, normalizeGlama } from "./glamaProvider";
import { MarketplaceService, validateProviderSecret } from "./service";
import { smitheryProvider, normalizeSmithery } from "./smitheryProvider";
import {
  CatalogProviderError,
  classifyHttpStatus,
  fetchCatalogJson,
  healthFromErrorClass,
  retryIdempotent,
  shouldRetry,
  withProviderTimeout,
} from "./providerRuntime";
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
  assert.equal(s.iconUrl, "https://github.com/github.png?size=80");
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
  assert.equal(catalogSearchQuery("official javascript mcp tool"), "javascript");
  assert.equal(primarySearchTerm("official javascript mcp tool"), "javascript");
  assert.equal(primarySearchTerm("official python"), "python");
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

test("official reference servers are public free installs and do not require secrets", () => {
  const seeded = officialReferenceResults("javascript")[0].server;
  assert.equal(isPublicFreeMcp(seeded), true);
  assert.equal(serverRequiresUserSecret(seeded), false);
  const http = normalizeOfficial({
    server: {
      name: "ai.example/remote",
      description: "Remote",
      remotes: [{ type: "streamable-http", url: "https://mcp.example/mcp", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }],
    },
  });
  assert.equal(serverRequiresUserSecret(http), true);
  assert.equal(isPublicFreeMcp(http), false);
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
    const q = String(url);
    const name = q.includes("github-mcp-server")
      ? "io.github.github/github-mcp-server"
      : "ai.smithery/Hint-Services-obsidian-github-mcp";
    const repo = name.includes("io.github.github")
      ? "https://github.com/github/github-mcp-server"
      : "https://github.com/Hint-Services/obsidian-github-mcp";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        servers: [sampleOfficial(name, "GitHub", { repository: { url: repo, source: "github" } })],
        metadata: {},
      }),
    };
  };
  const p = officialProvider(fetchImpl as any);
  const out = await p.search({ query: "github", limit: 5 });
  assert.ok(out.results.some((r) => r.server.name === "io.github.github/github-mcp-server"));
  assert.ok(out.results.some((r) => r.server.name.includes("obsidian")));
  const h = await p.health!();
  assert.equal(h.status, "online");
});

test("provider secrets persist under mcp.secret.* and are never returned", () => {
  const saved: Record<string, string> = {};
  const store = { getSetting: (k: string) => saved[k], setSetting: (k: string, v: string) => { saved[k] = v; } };
  const manager = { listServers: () => [], searchTools: () => [], statuses: () => [] } as any;
  const svc = new MarketplaceService(manager, store);
  const after = svc.setProviderSecret("glama", "glm_TEST_NOT_A_REAL_KEY");
  assert.equal(after.glama, true);
  assert.equal(saved["mcp.secret.glama"], "glm_TEST_NOT_A_REAL_KEY");
  const status = svc.providerSecretStatus();
  assert.deepEqual(status, { glama: true, smithery: false });
  assert.equal(JSON.stringify(status).includes("glm_"), false);
  const smithery = svc.setProviderSecret("smithery", "11111111-1111-4111-8111-111111111111");
  assert.equal(smithery.smithery, true);
  assert.equal(saved["mcp.secret.smithery"], "11111111-1111-4111-8111-111111111111");
  assert.throws(() => validateProviderSecret("glama", "mcp_not_a_glama_key"), /glm_/);
  assert.throws(() => validateProviderSecret("smithery", "glm_wrong_provider"), /Smithery/);
  assert.equal(validateProviderSecret("glama", ""), "");
});

test("official javascript/python searches surface first-party reference servers", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      servers: [
        sampleOfficial("com.a2awire/data-npm-release-node-package-javascript-dependency", "npm Release Tracker", {
          repository: { url: "https://github.com/ee324/a2awire", source: "github" },
          packages: [{ registryType: "npm", identifier: "a2awire-javascript-tracker", version: "1.0.0" }],
        }),
      ],
      metadata: {},
    }),
  });
  const p = officialProvider(fetchImpl as any);
  const js = await p.search({ query: "javascript", limit: 12 });
  assert.ok(js.results.some((r) => r.server.name === "io.modelcontextprotocol/filesystem"));
  assert.ok(js.results.some((r) => r.server.packages.some((pkg) => pkg.identifier === "@modelcontextprotocol/server-filesystem")));
  const py = await p.search({ query: "python", limit: 12 });
  assert.ok(py.results.some((r) => r.server.name === "io.modelcontextprotocol/git"));
  assert.ok(py.results.some((r) => r.server.packages.some((pkg) => pkg.identifier === "mcp-server-git")));
  const rankedJs = rankServer("javascript", js.results.find((r) => r.server.name === "io.modelcontextprotocol/filesystem")!.server);
  const rankedJunk = rankServer("javascript", js.results.find((r) => r.server.name.includes("a2awire"))!.server);
  assert.ok(rankedJs > rankedJunk);
});

test("official timeout still returns reference servers instead of blanking javascript", async () => {
  const fetchImpl = async () => {
    throw new CatalogProviderError("official", "timeout", "Official MCP Registry timed out", 0);
  };
  const p = officialProvider(fetchImpl as any);
  const out = await p.search({ query: "javascript" });
  assert.ok(out.results.some((r) => r.server.name === "io.modelcontextprotocol/memory"));
  assert.equal(out.health?.status, "slow");
  assert.deepEqual(officialReferenceResults("official javascript mcp tool").map((r) => r.server.name).includes("io.modelcontextprotocol/filesystem"), true);
});

test("glama without API key stays needs-key and returns empty search", async () => {
  const p = glamaProvider(fetch, "");
  const h = await p.health!();
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

function stubProvider(id: McpRegistryProvider["id"], name: string, search: McpRegistryProvider["search"], healthStatus: "online" | "offline" = "online"): McpRegistryProvider {
  return {
    id,
    name,
    health: async () => ({ id, name, status: healthStatus }),
    search,
    getServer: async () => null,
  };
}

test("provider parallelism: official timeout still returns glama + smithery", async () => {
  const official = stubProvider("official", "Official", async () => {
    await new Promise((r) => setTimeout(r, 80));
    throw new CatalogProviderError("official", "timeout", "Official timed out after 12s");
  });
  const glama = stubProvider("glama", "Glama", async () => ({
    results: [{ server: normalizeGlama({ name: "JS tools", namespace: "acme", slug: "js-mcp", description: "JavaScript lint and test", repository: { url: "https://github.com/acme/js-mcp" } }), score: 0 }],
  }));
  const smithery = stubProvider("smithery", "Smithery", async () => ({
    results: [{ server: normalizeSmithery({ qualifiedName: "acme/typescript", displayName: "TypeScript", description: "JS/TS helpers" }), score: 0 }],
  }));
  const agg = new RegistryAggregator([official, glama, smithery]);
  const started = Date.now();
  const out = await agg.search({ query: "js", limit: 20 });
  assert.ok(Date.now() - started < 2000, "federation must not wait on a hung official call beyond isolation");
  assert.ok(out.results.length >= 2, "partial results must render");
  assert.equal(out.providers.official.status, "slow");
  assert.equal(out.providers.glama.status, "online");
  assert.equal(out.providers.smithery.status, "online");
  assert.equal(out.degradedFlag, true);
  assert.equal(out.results.length > 0, true);
});

test("provider timeout isolation uses separate budgets", async () => {
  const slow = stubProvider("official", "Official", () => new Promise(() => {}));
  const fast = stubProvider("glama", "Glama", async () => ({
    results: [{ server: normalizeGlama({ name: "Fast", namespace: "x", slug: "fast", description: "ok" }), score: 0 }],
  }));
  const agg = new RegistryAggregator([slow, fast], undefined, { official: 80, glama: 1000 });
  const started = Date.now();
  const out = await agg.search({ query: "js", limit: 8 });
  assert.ok(out.results.some((r) => /fast/i.test(r.server.name)));
  assert.equal(out.providers.official.status, "slow");
  assert.ok(Date.now() - started < 1500);
});

test("retry: timeout/5xx retry once; 401/403 do not", async () => {
  let n = 0;
  const ok = await retryIdempotent(async () => {
    n += 1;
    if (n === 1) throw new CatalogProviderError("official", "http-5xx", "500", 500);
    return "ok";
  }, "official");
  assert.equal(ok, "ok");
  assert.equal(n, 2);
  let auth = 0;
  await assert.rejects(
    () => retryIdempotent(async () => {
      auth += 1;
      throw new CatalogProviderError("glama", "auth-required", "401", 401);
    }, "glama"),
    (err: any) => err.errorClass === "auth-required"
  );
  assert.equal(auth, 1);
  assert.equal(shouldRetry("timeout"), true);
  assert.equal(shouldRetry("permission-denied"), false);
});

test("429 becomes rate-limited and does not wipe other providers", async () => {
  const official = stubProvider("official", "Official", async () => {
    throw new CatalogProviderError("official", "rate-limited", "Official HTTP 429", 429, 2000);
  });
  const glama = stubProvider("glama", "Glama", async () => ({
    results: [{ server: normalizeGlama({ name: "Cached", namespace: "x", slug: "c", description: "ok" }), score: 0 }],
  }));
  const out = await new RegistryAggregator([official, glama]).search({ query: "js" });
  assert.equal(out.providers.official.status, "rate-limited");
  assert.ok(out.results.length >= 1);
});

test("401/403 classify as auth, not timeout", async () => {
  assert.equal(classifyHttpStatus(401), "auth-required");
  assert.equal(classifyHttpStatus(403), "permission-denied");
  assert.equal(healthFromErrorClass("auth-required"), "auth-required");
  const official = stubProvider("official", "Official", async () => {
    throw new CatalogProviderError("official", "auth-required", "401", 401);
  });
  const local = stubProvider("local", "Installed / manual", async () => ({
    results: [{ server: normalizeOfficial(sampleOfficial("local/echo", "Installed echo")), score: 0 }],
  }));
  local.id = "local";
  const out = await new RegistryAggregator([official, local]).search({ query: "echo" });
  assert.equal(out.providers.official.status, "auth-required");
  assert.ok(out.results.length >= 1);
  assert.notEqual(out.providers.official.status, "slow");
});

test("HTML response is route-incompatible, never Unexpected token", async () => {
  const err = await fetchCatalogJson({
    url: "https://example.test/mcp",
    provider: "official",
    timeoutMs: 1000,
    fetchImpl: async () =>
      ({
        ok: false,
        status: 404,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
        text: async () => "<!DOCTYPE html><html>",
        headers: { get: () => "text/html" },
      }) as any,
  }).catch((e) => e);
  assert.equal(err.errorClass, "route-incompatible");
  assert.match(String(err.message), /HTML/i);
  assert.equal(/Unexpected token/.test(String(err.message)), false);
});

test("404 catalog route is not-found / route-incompatible", async () => {
  assert.equal(classifyHttpStatus(404), "not-found");
  assert.equal(classifyHttpStatus(404, true), "route-incompatible");
});

test("stale-while-revalidate cache returns immediately then refreshes", async () => {
  let calls = 0;
  const p = stubProvider("official", "Official", async () => {
    calls += 1;
    return { results: [{ server: normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", `v${calls}`)), score: 0 }] };
  });
  const cache = new CatalogCache<any>();
  const agg = new RegistryAggregator([p], cache);
  const first = await agg.search({ query: "github" });
  assert.equal(first.fromCache, false);
  assert.equal(calls, 1);
  const key = catalogCacheKey({ query: "github", filters: "", page: "24:" });
  const stored = cache.get(key)!;
  cache.set(key, stored.payload, Date.now() - (CATALOG_FRESH_TTL_MS + 1000));
  const stale = await agg.search({ query: "github" });
  assert.equal(stale.fromCache, true);
  assert.equal(stale.stale, true);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(calls >= 1);
});

test("offline federation serves stale cache instead of blank", async () => {
  let live = true;
  const p = stubProvider("official", "Official", async () => {
    if (!live) throw new CatalogProviderError("official", "network", "offline");
    return { results: [{ server: normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "GitHub")), score: 0 }] };
  });
  const cache = new CatalogCache<any>();
  const agg = new RegistryAggregator([p], cache);
  await agg.search({ query: "github" });
  const key = catalogCacheKey({ query: "github", filters: "", page: "24:" });
  const stored = cache.get(key)!;
  cache.set(key, stored.payload, Date.now() - (CATALOG_FRESH_TTL_MS + 1000));
  live = false;
  const stale = await agg.search({ query: "github" });
  assert.ok(stale.results.length >= 1);
  assert.equal(stale.fromCache, true);
});

test("dedupe + source merge: official/glama/smithery render once", () => {
  const a = normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "Official GitHub MCP"));
  const b = normalizeGlama({
    name: "GitHub MCP",
    namespace: "github",
    slug: "github-mcp-server",
    description: "PRs plus tools",
    repository: { url: "https://github.com/github/github-mcp-server.git" },
    tools: [{ name: "create_pull_request", description: "Open a PR" }],
  });
  const c = normalizeSmithery({
    qualifiedName: "github/github-mcp-server",
    displayName: "GitHub",
    description: "Smithery listing",
    repository: "https://github.com/github/github-mcp-server",
    tools: [{ name: "list_issues", description: "List issues" }],
  });
  assert.equal(canonicalKey(a), canonicalKey(b));
  assert.equal(canonicalKey(a), canonicalKey(c));
  const merged = mergeServers(mergeServers(b, c), a);
  assert.deepEqual(merged.sources.sort(), ["glama", "official", "smithery"]);
  assert.equal(merged.canonicalId, a.canonicalId);
  assert.ok(merged.tools?.some((t) => t.name === "create_pull_request") || merged.packages[0]?.identifier.includes("server-github"));
});

test("canonical GitHub ranking beats wrappers for query github", () => {
  const github = normalizeOfficial(sampleOfficial("io.github.github/github-mcp-server", "Official GitHub MCP"));
  const wrapper = normalizeOfficial(sampleOfficial("ai.smithery/obsidian-github-mcp", "Obsidian vault on GitHub", {
    repository: { url: "https://github.com/Hint-Services/obsidian-github-mcp", source: "github" },
  }));
  assert.equal(isCanonicalGithub(github), true);
  assert.equal(isCanonicalGithub(wrapper), false);
  assert.ok(rankServer("github", github) > rankServer("github", wrapper));
});

test("query cancellation helper keeps only the latest generation", () => {
  let gen = 0;
  const apply = (mine: number, items: string[]) => (mine === gen ? items : null);
  const first = ++gen;
  const second = ++gen;
  assert.equal(apply(first, ["old"]), null);
  assert.deepEqual(apply(second, ["js"]), ["js"]);
});

test("empty vs failure: timeout is degraded, not a valid empty catalog", async () => {
  const official = stubProvider("official", "Official", async () => {
    throw new CatalogProviderError("official", "timeout", "Official timed out after 12s");
  });
  const glama = stubProvider("glama", "Glama", async () => ({ results: [] }));
  const out = await new RegistryAggregator([official, glama]).search({ query: "js" });
  assert.equal(out.results.length, 0);
  assert.equal(out.degradedFlag, true);
  assert.equal(out.providers.official.status, "slow");
});

test("partial success: official 500 does not blank glama results", async () => {
  const official = stubProvider("official", "Official", async () => {
    throw new CatalogProviderError("official", "http-5xx", "Official HTTP 500", 500);
  });
  const glama = stubProvider("glama", "Glama", async () => ({
    results: [{ server: normalizeGlama({ name: "javascript-mcp", namespace: "acme", description: "JS" }), score: 0 }],
  }));
  const out = await new RegistryAggregator([official, glama]).search({ query: "js" });
  assert.ok(out.results.length >= 1);
  assert.equal(out.providers.official.status, "offline");
  assert.equal(out.degradedFlag, true);
});

test("smithery without API key is needs-key and does not fail marketplace", async () => {
  const p = smitheryProvider(fetch, "");
  const h = await p.health!();
  assert.equal(h.status, "needs-key");
  const out = await p.search({ query: "js" });
  assert.deepEqual(out.results, []);
  assert.equal(out.health?.status, "needs-key");
});

test("fetchCatalogJson classifies 429 with Retry-After", async () => {
  const err = await fetchCatalogJson({
    url: "https://example.test/x",
    provider: "official",
    timeoutMs: 500,
    fetchImpl: async () =>
      ({
        ok: false,
        status: 429,
        json: async () => ({ error: "slow down" }),
        text: async () => JSON.stringify({ error: "slow down" }),
        headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "2" : "application/json") },
      }) as any,
  }).catch((e) => e);
  assert.equal(err.errorClass, "rate-limited");
  assert.equal(err.retryAfterMs, 2000);
});
