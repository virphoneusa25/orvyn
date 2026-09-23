import { test } from "node:test";
import assert from "node:assert/strict";
import {
  brandIconSrc,
  githubOwnerAvatar,
  homepageFavicon,
  iconCandidates,
  parseApiJson,
  resolveMarketplaceIcon,
} from "./mcpMarketplaceIcons.ts";
import type { MarketServer } from "./mcpMarketplaceModel.ts";

function sample(partial: Partial<MarketServer> & { name: string }): MarketServer {
  return {
    canonicalId: partial.canonicalId ?? partial.name,
    description: partial.description ?? "desc",
    sources: partial.sources ?? ["official"],
    categories: [],
    transports: [{ kind: "stdio" }],
    auth: [],
    trust: { level: "community", reasons: [] },
    compatibility: "compatible",
    networkRequired: false,
    ...partial,
  };
}

test("HTML marketplace responses become a control-plane error, not JSON.parse crash", () => {
  const html = parseApiJson(200, "<!DOCTYPE html><html><body>nginx</body></html>");
  assert.equal(html.ok, false);
  assert.match(html.error ?? "", /HTML/);
  assert.match(html.error ?? "", /control plane|Local Mode/);
  const unauthorized = parseApiJson(401, "<!DOCTYPE html>");
  assert.match(unauthorized.error ?? "", /signed-in|HTML/);
  const ok = parseApiJson(200, JSON.stringify({ results: [] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.body.results, []);
  const fail = parseApiJson(502, JSON.stringify({ error: "Official registry HTTP 502" }));
  assert.equal(fail.ok, false);
  assert.equal(fail.error, "Official registry HTTP 502");
});

test("GitHub / PostgreSQL rows resolve real product or publisher icons", () => {
  const github = sample({
    name: "io.github.github/github-mcp-server",
    title: "GitHub MCP",
    repository: "https://github.com/github/github-mcp-server",
  });
  const icon = resolveMarketplaceIcon(github);
  assert.equal(icon.kind, "image");
  assert.ok(icon.src?.startsWith("data:image/svg+xml") || icon.src?.includes("github.com/github.png"));
  assert.ok(brandIconSrc("GitHub MCP"));
  const pg = sample({
    name: "io.github.musaddiq-dev/postgresql-mcp-server",
    title: "PostgreSQL MCP Server",
    repository: "https://github.com/musaddiq-dev/postgresql-mcp-server",
  });
  const candidates = iconCandidates(pg);
  assert.ok(candidates.some((c) => c.includes("github.com/musaddiq-dev.png")));
  assert.ok(candidates.some((c) => c.startsWith("data:image/svg+xml")));
  assert.ok(candidates[0].includes("github.com/musaddiq-dev.png") || candidates[0].startsWith("data:image/svg+xml"));
});

test("publisher avatars and homepage favicons stay https-only", () => {
  assert.equal(githubOwnerAvatar("https://github.com/cloudflare/mcp-server-cloudflare"), "https://github.com/cloudflare.png?size=80");
  assert.equal(githubOwnerAvatar("https://example.com/x"), undefined);
  assert.equal(homepageFavicon("https://www.postgresql.org"), "https://icons.duckduckgo.com/ip3/www.postgresql.org.ico");
  assert.equal(homepageFavicon("not-a-url"), undefined);
});
