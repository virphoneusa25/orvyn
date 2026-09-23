import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_GITHUB_QUERY,
  decideCatalogSource,
  dedupeServers,
  installPayload,
  isProductGithub,
  loadOfficialFallbackCatalog,
  markMarketplaceUnsupported,
  normalizeOfficialRow,
  rankOfficialResults,
  resetMarketplaceSupport,
  resolveMarketplaceCatalog,
  shouldUseHostInstall,
  shouldUseOfficialFallback,
  supplementQueries,
  BROWSE_SEED_QUERIES,
} from "./mcpOfficialCatalog.ts";
import { parseApiJson } from "./mcpMarketplaceIcons.ts";

function officialRow(name: string, extra: Record<string, unknown> = {}) {
  const serverExtra = extra.server && typeof extra.server === "object" ? (extra.server as Record<string, unknown>) : {};
  return {
    server: {
      name,
      title: String(extra.title ?? name.split("/").pop()),
      description: String(extra.description ?? "MCP server"),
      version: "1.2.3",
      repository: { url: extra.repository ?? `https://github.com/${name.replace(/^io\.github\./, "")}` },
      packages: extra.packages ?? [{ registryType: "npm", identifier: "@modelcontextprotocol/server-github", version: "1.2.3" }],
      remotes: extra.remotes ?? [],
      icons: extra.icons,
      ...serverExtra,
    },
  };
}

test("Cloud HTML/empty catalog must fall back to Official Registry", () => {
  assert.equal(shouldUseOfficialFallback(false, 0, 404, true), true);
  assert.equal(shouldUseOfficialFallback(true, 0, 200, false), false);
  assert.equal(shouldUseOfficialFallback(true, 4, 200, false), false);
});

test("401 and 403 stay auth/permission failures — no public registry fallback", () => {
  const unauth = decideCatalogSource({
    status: 401,
    parsed: parseApiJson(401, JSON.stringify({ error: "Unauthorized — missing API key" })),
    catalogCount: 0,
  });
  assert.equal(unauth.state, "auth-required");
  assert.equal(unauth.useOfficialFallback, false);
  const forbidden = decideCatalogSource({
    status: 403,
    parsed: parseApiJson(403, "<html>", "text/html"),
    catalogCount: 0,
  });
  assert.equal(forbidden.state, "auth-required");
  assert.equal(forbidden.useOfficialFallback, false);
});

test("valid 200 with zero results is an empty catalog, not an unsupported route", () => {
  const empty = decideCatalogSource({
    status: 200,
    parsed: parseApiJson(200, JSON.stringify({ results: [] }), "application/json"),
    catalogCount: 0,
  });
  assert.equal(empty.state, "cloud");
  assert.equal(empty.useOfficialFallback, false);
});

test("Cloud 500 stays an error and does not hide behind Official Registry", () => {
  const boom = decideCatalogSource({
    status: 500,
    parsed: parseApiJson(500, JSON.stringify({ error: "boom" })),
    catalogCount: 0,
  });
  assert.equal(boom.state, "error");
  assert.equal(boom.useOfficialFallback, false);
});

test("normalize Official Registry GitHub row for the two-pane marketplace", () => {
  const s = normalizeOfficialRow(
    officialRow("io.github.github/github-mcp-server", {
      title: "GitHub MCP",
      description: "GitHub pull requests and issues",
      repository: "https://github.com/github/github-mcp-server",
    })
  );
  assert.equal(s.sources[0], "official");
  assert.equal(s.title, "GitHub MCP");
  assert.ok(s.transports.some((t) => t.kind === "stdio" && t.args?.some((a) => a.includes("@modelcontextprotocol/server-github@1.2.3"))));
  assert.ok(s.categories.includes("Version Control"));
  assert.equal(isProductGithub(s), true);
  assert.equal(isProductGithub({ name: "ai.smithery/obsidian-github-mcp", title: "Obsidian GitHub" }), false);
});

test("empty browse seeds more than GitHub so the catalog is not a handful of wrappers", () => {
  const seeds = supplementQueries("");
  assert.ok(seeds.includes(CANONICAL_GITHUB_QUERY));
  assert.ok(seeds.includes("filesystem"));
  assert.ok(seeds.includes("postgres"));
  assert.ok(seeds.includes("slack"));
  assert.ok(BROWSE_SEED_QUERIES.length >= 8);
});

test("github search ranks the canonical Official Registry server first when present", async () => {
  assert.deepEqual(supplementQueries("github"), [CANONICAL_GITHUB_QUERY]);
  const ranked = rankOfficialResults("github", [
    normalizeOfficialRow(officialRow("ai.smithery/obsidian-github-mcp", { title: "Obsidian GitHub", repository: "https://github.com/Hint-Services/obsidian-github-mcp" })),
    normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" })),
  ]);
  assert.equal(ranked[0].name, "io.github.github/github-mcp-server");
});

test("empty Cloud browse seeds GitHub via a real Registry query, never a fabricated card", async () => {
  const calls: string[] = [];
  const catalog = await loadOfficialFallbackCatalog("", async (query) => {
    calls.push(query);
    if (query === CANONICAL_GITHUB_QUERY) {
      return {
        ok: true,
        body: {
          servers: [
            officialRow("com.thenextgennexus/github-mcp-server", { title: "Other", repository: "https://github.com/other/github-mcp-server" }),
            officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" }),
          ],
        },
      };
    }
    return {
      ok: true,
      body: {
        servers: [officialRow("ai.example/random", { title: "Random", repository: "https://github.com/example/random" })],
      },
    };
  });
  assert.ok(calls.includes(""));
  assert.ok(calls.includes(CANONICAL_GITHUB_QUERY));
  assert.equal(isProductGithub(catalog[0]), true);
  assert.equal(catalog[0].name, "io.github.github/github-mcp-server");
});

test("resolveMarketplaceCatalog: Cloud JSON works; 404/HTML fall back; 401 does not", async () => {
  resetMarketplaceSupport();
  const github = officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" });
  const loadOfficial = async () => [normalizeOfficialRow(github)];

  const cloud = await resolveMarketplaceCatalog({
    status: 200,
    text: JSON.stringify({ results: [{ server: { canonicalId: "cloud-1", name: "cloud-1", title: "Cloud", description: "from control plane", sources: ["official"], categories: [], transports: [{ kind: "http" }], auth: [], trust: { level: "community", reasons: [] }, compatibility: "compatible", networkRequired: false } }] }),
    contentType: "application/json",
    query: "github",
    backendUrl: "https://orvyn.virphoneusa.com",
    loadOfficial,
  });
  assert.equal(cloud.state, "cloud");
  assert.equal(cloud.catalog[0].canonicalId, "cloud-1");

  resetMarketplaceSupport("https://orvyn.virphoneusa.com");
  const html = await resolveMarketplaceCatalog({
    status: 404,
    text: "<!DOCTYPE html><html><body>nginx</body></html>",
    contentType: "text/html",
    query: "github",
    backendUrl: "https://orvyn.virphoneusa.com",
    loadOfficial,
  });
  assert.equal(html.state, "official-fallback");
  assert.equal(html.catalog[0].name, "io.github.github/github-mcp-server");
  assert.match(html.notice ?? "", /Official Registry/);

  const auth = await resolveMarketplaceCatalog({
    status: 401,
    text: JSON.stringify({ error: "Unauthorized — missing API key" }),
    contentType: "application/json",
    query: "github",
    backendUrl: "https://orvyn.example",
    loadOfficial,
  });
  assert.equal(auth.state, "auth-required");
  assert.equal(auth.catalog.length, 0);
  assert.match(auth.error ?? "", /signed-in|Unauthorized|401/i);
});

test("cached unsupported host skips inventing Cloud support and uses Official fallback", async () => {
  resetMarketplaceSupport();
  markMarketplaceUnsupported("https://orvyn.virphoneusa.com");
  const out = await resolveMarketplaceCatalog({
    status: 200,
    text: JSON.stringify({ results: [] }),
    query: "github",
    backendUrl: "https://orvyn.virphoneusa.com",
    loadOfficial: async () => [normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" }))],
  });
  assert.equal(out.state, "official-fallback");
  resetMarketplaceSupport();
});

test("Official Registry unavailable becomes degraded, not a fake GitHub card", async () => {
  resetMarketplaceSupport();
  const out = await resolveMarketplaceCatalog({
    status: 404,
    text: "<html>",
    contentType: "text/html",
    query: "github",
    backendUrl: "https://orvyn.virphoneusa.com",
    loadOfficial: async () => {
      throw new Error("Official registry HTTP 502");
    },
  });
  assert.equal(out.state, "degraded");
  assert.equal(out.catalog.length, 0);
  assert.match(out.error ?? "", /502|unavailable/i);
});

test("preferKnownProducts + dedupe keep one GitHub card", () => {
  const a = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub MCP", repository: "https://github.com/github/github-mcp-server" }));
  const b = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" }));
  const ranked = rankOfficialResults("github", dedupeServers([b, a]));
  assert.equal(ranked.length, 1);
  assert.equal(isProductGithub(ranked[0]), true);
});

test("install payload can use /mcp/servers only when marketplace/install is an unsupported route", () => {
  const s = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub MCP" }));
  const payload = installPayload(s);
  assert.equal(payload.transport, "stdio");
  assert.equal(payload.name, "GitHub MCP");
  assert.ok(payload.command);
  assert.equal(shouldUseHostInstall(parseApiJson(404, "<html>", "text/html"), 404), true);
  assert.equal(shouldUseHostInstall(parseApiJson(401, JSON.stringify({ error: "no" })), 401), false);
});
