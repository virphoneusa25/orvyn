import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeServers,
  installPayload,
  isProductGithub,
  loadOfficialFallbackCatalog,
  normalizeOfficialRow,
  preferKnownProducts,
  shouldUseOfficialFallback,
} from "./mcpOfficialCatalog.ts";

function officialRow(name: string, extra: Record<string, unknown> = {}) {
  return {
    server: {
      name,
      title: String(extra.title ?? name.split("/").pop()),
      description: String(extra.description ?? "MCP server"),
      version: "1.2.3",
      repository: { url: extra.repository ?? `https://github.com/${name.replace(/^io\.github\./, "").replace("/", "/")}` },
      packages: extra.packages ?? [{ registryType: "npm", identifier: "@modelcontextprotocol/server-github", version: "1.2.3" }],
      remotes: extra.remotes ?? [],
      icons: extra.icons,
      ...extra.server,
    },
  };
}

test("Cloud HTML/empty catalog must fall back to Official Registry", () => {
  assert.equal(shouldUseOfficialFallback(false, 0), true);
  assert.equal(shouldUseOfficialFallback(true, 0), true);
  assert.equal(shouldUseOfficialFallback(true, 4), false);
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

test("empty Cloud browse seeds GitHub ahead of unrelated official listings", async () => {
  const calls: string[] = [];
  const catalog = await loadOfficialFallbackCatalog("", async (query) => {
    calls.push(query);
    if (query === "github-mcp-server") {
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
    if (query === "postgres") {
      return {
        ok: true,
        body: { servers: [officialRow("io.github.postgres/postgres", { title: "PostgreSQL", repository: "https://github.com/postgres/postgres" })] },
      };
    }
    return {
      ok: true,
      body: {
        servers: [
          officialRow("ai.example/random", { title: "Random", repository: "https://github.com/example/random" }),
        ],
      },
    };
  });
  assert.deepEqual(calls, ["", "github-mcp-server", "postgres"]);
  assert.equal(isProductGithub(catalog[0]), true);
  assert.equal(catalog[0].title, "GitHub");
  assert.ok(catalog.some((s) => s.title === "Random"));
  assert.ok(catalog.some((s) => /postgres/i.test(s.title ?? s.name)));
});

test("preferKnownProducts + dedupe keep one GitHub card", () => {
  const a = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub MCP", repository: "https://github.com/github/github-mcp-server" }));
  const b = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub", repository: "https://github.com/github/github-mcp-server" }));
  const ranked = preferKnownProducts(dedupeServers([b, a]));
  assert.equal(ranked.length, 1);
  assert.equal(isProductGithub(ranked[0]), true);
});

test("install payload can use /mcp/servers when marketplace/install is missing", () => {
  const s = normalizeOfficialRow(officialRow("io.github.github/github-mcp-server", { title: "GitHub MCP" }));
  const payload = installPayload(s);
  assert.equal(payload.transport, "stdio");
  assert.equal(payload.name, "GitHub MCP");
  assert.ok(payload.command);
});
