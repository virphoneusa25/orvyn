import { test } from "node:test";
import assert from "node:assert/strict";
import { parseApiJson } from "./mcpMarketplaceIcons.ts";
import { shouldUseHostInstall } from "./mcpOfficialCatalog.ts";
import {
  GITHUB_MCP_HTTP,
  isPublicFreeMcp,
  marketplaceSecrets,
  mergeMcpStatusLists,
  prepareMarketplaceInstall,
  publicInstallSteps,
  serverRequiresUserSecret,
  shouldInstallOnLocalEngine,
  shouldUseLocalPublicInstall,
} from "./mcpPublicInstall.ts";
import type { MarketServer } from "./mcpMarketplaceModel.ts";

function server(partial: Partial<MarketServer> & { name: string }): MarketServer {
  return {
    canonicalId: partial.canonicalId ?? partial.name,
    description: partial.description ?? "desc",
    sources: partial.sources ?? ["official"],
    categories: [],
    transports: partial.transports ?? [{ kind: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }],
    auth: partial.auth ?? [{ kind: "none", label: "No auth advertised" }],
    trust: { level: "verified", reasons: ["official"] },
    compatibility: "compatible",
    networkRequired: false,
    ...partial,
  };
}

test("official filesystem is a free public install with no secret step", () => {
  const s = server({ name: "io.modelcontextprotocol/filesystem" });
  assert.equal(isPublicFreeMcp(s), true);
  assert.equal(serverRequiresUserSecret(s), false);
  assert.deepEqual(publicInstallSteps(s), ["Review", "Permissions", "Confirm", "Done"]);
});

test("oauth / bearer servers still require the user secret step", () => {
  const s = server({
    name: "io.github.github/github-mcp-server",
    auth: [{ kind: "oauth", label: "GitHub" }],
    transports: [{ kind: "http", url: "https://api.githubcopilot.com/mcp/" }],
  });
  assert.equal(serverRequiresUserSecret(s), true);
  assert.equal(isPublicFreeMcp(s), false);
  assert.ok(publicInstallSteps(s).includes("Authentication"));
});

test("cloud 401 falls back to local public install instead of demanding a platform API key", () => {
  const s = server({ name: "io.modelcontextprotocol/memory" });
  const parsed = parseApiJson(401, JSON.stringify({ error: "Unauthorized — missing API key" }));
  assert.equal(shouldUseHostInstall(parsed, 401), false);
  assert.equal(
    shouldUseLocalPublicInstall({ status: 401, parsed, server: s, hasPlatformKey: false, backendIsCloud: true }),
    true
  );
});

test("stdio-only servers install on the local engine when Cloud is the control plane", () => {
  const s = server({ name: "io.modelcontextprotocol/memory" });
  assert.equal(shouldInstallOnLocalEngine(s, true), true);
  assert.equal(shouldInstallOnLocalEngine(s, false), false);
});

test("GitHub on Cloud prefers the remote HTTP endpoint so the agent can use it", () => {
  const s = server({
    canonicalId: "io.github.github/github-mcp-server",
    name: "io.github.github/github-mcp-server",
    auth: [{ kind: "none", label: "No auth advertised" }],
  });
  const prepared = prepareMarketplaceInstall(s, true);
  assert.equal(prepared.transports.some((t) => t.kind === "http" && t.url === GITHUB_MCP_HTTP), true);
  assert.equal(prepared.auth.some((a) => a.kind === "oauth"), true);
  assert.equal(shouldInstallOnLocalEngine(prepared, true), false);
});

test("GitHub token aliases map onto GITHUB_PERSONAL_ACCESS_TOKEN", () => {
  const s = server({ canonicalId: "io.github.github/github-mcp-server", name: "io.github.github/github-mcp-server" });
  assert.equal(marketplaceSecrets(s, { token: "ghp_abc" })?.GITHUB_PERSONAL_ACCESS_TOKEN, "ghp_abc");
});

test("Installed tab merges local desktop statuses with the cloud control plane", () => {
  const merged = mergeMcpStatusLists(
    [{ id: "cloud-only", name: "Remote", state: "DISCONNECTED" }],
    [{ id: "git", name: "Git", state: "CONNECTED" }, { id: "cloud-only", name: "Remote", state: "ERROR" }]
  );
  assert.equal(merged.some((s) => s.id === "git" && s.state === "CONNECTED"), true);
  assert.equal(merged.find((s) => s.id === "cloud-only")?.state, "ERROR");
});
