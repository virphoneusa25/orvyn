import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTERS,
  applyFilters,
  clampSidebar,
  executionLocation,
  filterActiveCount,
  formatRisk,
  groupMarketplace,
  initials,
  mergeInstalled,
  overlaySidebar,
  pickSelectedServer,
  permissionSummary,
  sidebarForContainer,
  primaryAction,
  providerWarning,
  recommendServers,
  schemaArgNames,
  selectByOffset,
  serverLabel,
  tabAvailable,
  toolsAdvertisedLabel,
  uninstallCopy,
  type MarketServer,
} from "./mcpMarketplaceModel.ts";

function sample(partial: Partial<MarketServer> & { name: string }): MarketServer {
  return {
    canonicalId: partial.canonicalId ?? partial.name,
    description: partial.description ?? "desc",
    publisher: partial.publisher ?? "acme",
    sources: partial.sources ?? ["official"],
    categories: partial.categories ?? ["Developer Tools"],
    transports: partial.transports ?? [{ kind: "stdio" }],
    auth: partial.auth ?? [{ kind: "none", label: "None" }],
    trust: partial.trust ?? { level: "community", reasons: ["official"] },
    compatibility: "compatible",
    networkRequired: partial.networkRequired ?? false,
    ...partial,
  };
}

test("search/filter: source, trust, installed, transport, category", () => {
  const github = sample({
    name: "io.github.github/github-mcp-server",
    title: "GitHub MCP",
    sources: ["official"],
    trust: { level: "verified", reasons: [] },
    transports: [{ kind: "http", url: "https://mcp.github" }],
    installed: { serverId: "mcp_1", enabled: true, state: "CONNECTED" },
    categories: ["Version Control"],
  });
  const local = sample({ name: "echo", sources: ["local"], transports: [{ kind: "stdio" }], trust: { level: "unverified", reasons: [] } });
  const all = [github, local];
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, sources: ["official"] }).length, 1);
  assert.equal(applyFilters([github, sample({ name: "smithery-js", sources: ["smithery"] })], { ...EMPTY_FILTERS, sources: ["smithery"] }).length, 1);
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, status: "installed" })[0].name, github.name);
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, status: "not-installed" })[0].name, "echo");
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, trust: "verified" }).length, 1);
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, transport: "http" }).length, 1);
  assert.equal(applyFilters(all, { ...EMPTY_FILTERS, category: "Version Control" }).length, 1);
  assert.equal(filterActiveCount({ ...EMPTY_FILTERS, sources: ["official"], trust: "verified" }), 2);
});

test("selection walks the visible id list without leaving the marketplace", () => {
  const ids = ["a", "b", "c"];
  assert.equal(selectByOffset(ids, null, 1), "a");
  assert.equal(selectByOffset(ids, "a", 1), "b");
  assert.equal(selectByOffset(ids, "c", 1), "c");
  assert.equal(selectByOffset(ids, "a", -1), "a");
});

test("detail tabs stay available; changelog only when real notes exist", () => {
  const s = sample({ name: "github" });
  assert.equal(tabAvailable("details", s), true);
  assert.equal(tabAvailable("tools", s), true);
  assert.equal(tabAvailable("permissions", s), true);
  assert.equal(tabAvailable("changelog", s), false);
  assert.equal(tabAvailable("changelog", s, "Fixed auth refresh in 1.2.3"), true);
  assert.equal(tabAvailable("changelog", s, "ORVYN does not auto-upgrade executable MCP servers."), false);
});

test("Installed / Discover / Recommended / Updates grouping", () => {
  const installed = sample({ name: "echo", installed: { serverId: "mcp_e", enabled: true, state: "CONNECTED" }, sources: ["local"] });
  const github = sample({ name: "github", title: "GitHub", sources: ["official"] });
  const slack = sample({ name: "slack", sources: ["glama"] });
  const groups = groupMarketplace(
    [installed, github, slack],
    [{ serverId: "mcp_e", name: "echo", current: "1.0.0", changelog: "pin" }],
    [{ server: github, reason: "ORION asked for PRs" }]
  );
  assert.equal(groups.installed.length, 1);
  assert.equal(groups.discover.map((s) => s.name).join(), "slack");
  assert.equal(groups.recommended[0].server.name, "github");
  assert.equal(groups.updates.length, 1);
});

test("server row facts: label, location, initials — no invented ratings", () => {
  const s = sample({ name: "io.github.github/github-mcp-server", title: "GitHub MCP", transports: [{ kind: "http", url: "https://x" }] });
  assert.equal(serverLabel(s), "GitHub MCP");
  assert.equal(
    serverLabel(sample({ name: "ai.smithery/python-dev-pro-egw-writings", title: "python-dev-pro-egw-writings" })),
    "Python Dev Pro Egw Writings"
  );
  assert.equal(executionLocation(s), "remote");
  assert.equal(initials(s), "GH");
  assert.equal(initials(sample({ name: "pg", title: "PostgreSQL" })), "PS");
  assert.equal(initials(sample({ name: "slack", title: "Slack Bot" })), "SB");
  assert.equal(formatRisk("WRITE"), "WRITE");
  assert.equal(formatRisk("external-side-effect"), "EXTERNAL SIDE EFFECT");
  assert.deepEqual(schemaArgNames({ type: "object", properties: { title: {}, body: {} } }), ["title", "body"]);
});

test("primary actions: install, connect, connected, disable, enable, update", () => {
  const fresh = sample({ name: "pg", transports: [{ kind: "stdio" }] });
  assert.deepEqual(primaryAction(fresh), { kind: "install", label: "Install" });
  const http = sample({ name: "remote", transports: [{ kind: "http", url: "https://x" }] });
  assert.equal(primaryAction(http).label, "Connect");
  const needs = sample({ name: "gh", installed: { serverId: "1", enabled: true, state: "NEEDS_AUTH" }, auth: [{ kind: "oauth", label: "OAuth" }] });
  assert.deepEqual(primaryAction(needs), { kind: "connect", label: "Connect" });
  const live = sample({ name: "gh", installed: { serverId: "1", enabled: true, state: "CONNECTED" } });
  assert.deepEqual(primaryAction(live), { kind: "connected", label: "Connected" });
  const off = sample({ name: "gh", installed: { serverId: "1", enabled: false, state: "DISABLED" } });
  assert.equal(primaryAction(off).kind, "enable");
  assert.equal(primaryAction(live, true).kind, "update");
});

test("Needs Auth filter matches only that state", () => {
  const a = sample({ name: "a", installed: { serverId: "1", enabled: true, state: "NEEDS_AUTH" } });
  const b = sample({ name: "b", installed: { serverId: "2", enabled: true, state: "CONNECTED" } });
  assert.deepEqual(applyFilters([a, b], { ...EMPTY_FILTERS, status: "needs-auth" }).map((s) => s.name), ["a"]);
});

test("disable vs uninstall copy: uninstall explains secrets and catalog remains", () => {
  const s = sample({ name: "github", title: "GitHub MCP" });
  const copy = uninstallCopy(s);
  assert.match(copy, /removed/);
  assert.match(copy, /Secret/);
  assert.match(copy, /discoverable/);
});

test("provider degradation lists Glama without failing Official", () => {
  const warnings = providerWarning([
    { id: "official", name: "Official", status: "online" },
    { id: "glama", name: "Glama", status: "offline", detail: "down" },
  ]);
  assert.deepEqual(warnings, ["Glama unavailable"]);
});

test("tools/list merge: installed status tools replace catalog stubs", () => {
  const catalog = [sample({ name: "github", title: "GitHub", tools: [{ name: "stub", description: "catalog", risk: "read", origin: "declared" }] })];
  const merged = mergeInstalled(catalog, [
    { id: "mcp_1", name: "GitHub", state: "CONNECTED", enabled: true, toolCount: 2, tools: [{ name: "create_pull_request", description: "Open a PR", risk: "WRITE" }] },
  ]);
  assert.equal(merged[0].installed?.state, "CONNECTED");
  assert.equal(merged[0].tools?.[0].name, "create_pull_request");
  assert.equal(merged[0].tools?.[0].origin, "live");
  assert.equal(merged[0].toolCount, 2);
  const withLocal = mergeInstalled(catalog, [
    { id: "mcp_1", name: "GitHub", state: "CONNECTED", enabled: true, toolCount: 2, tools: [{ name: "create_pull_request", description: "Open a PR", risk: "WRITE" }] },
    { id: "mcp_manual", name: "echo", state: "CONNECTED", enabled: true, toolCount: 1 },
  ]);
  assert.ok(withLocal.some((s) => s.canonicalId === "local:mcp_manual"));
});

test("permissions tab classifies read vs write from ORVYN risk tags", () => {
  const s = sample({
    name: "github",
    networkRequired: true,
    filesystemScope: "project",
    transports: [{ kind: "http", url: "https://x" }],
    tools: [
      { name: "list_issues", description: "List", risk: "READ" },
      { name: "create_pull_request", description: "PR", risk: "WRITE" },
      { name: "delete_repo", description: "Boom", risk: "DESTRUCTIVE" },
    ],
  });
  const p = permissionSummary(s);
  assert.ok(p.can.some((x) => /project/i.test(x)));
  assert.ok(p.may.some((x) => /destructive/i.test(x)));
});

test("ORION capability query deep-links GitHub recommendations first", () => {
  const servers = [
    sample({ name: "unrelated" }),
    sample({ name: "io.github.github/github-mcp-server", title: "GitHub MCP", sources: ["official"] }),
  ];
  const rec = recommendServers(servers, { query: "create a pull request" });
  assert.equal(rec[0].server.title, "GitHub MCP");
  assert.match(rec[0].reason, /pull-request|GitHub/);
});

test("javascript and python queries recommend official reference servers", () => {
  const filesystem = sample({
    name: "io.modelcontextprotocol/filesystem",
    title: "Filesystem",
    sources: ["official"],
    packages: [{ registry: "npm", identifier: "@modelcontextprotocol/server-filesystem" }],
  });
  const git = sample({
    name: "io.modelcontextprotocol/git",
    title: "Git",
    sources: ["official"],
    packages: [{ registry: "pypi", identifier: "mcp-server-git" }],
  });
  const junk = sample({ name: "com.a2awire/javascript-tracker", title: "npm Release Tracker", sources: ["official"] });
  const js = recommendServers([junk, filesystem, git], { query: "official javascript mcp tool" });
  assert.equal(js[0].server.name, "io.modelcontextprotocol/filesystem");
  const py = recommendServers([junk, filesystem, git], { query: "python" });
  assert.equal(py[0].server.name, "io.modelcontextprotocol/git");
});

test("empty browse still recommends official GitHub so Cloud Mode is not a blank form", () => {
  const servers = [
    sample({ name: "ai.example/random", title: "Random" }),
    sample({ name: "io.github.github/github-mcp-server", title: "GitHub MCP", sources: ["official"] }),
    sample({ name: "io.github.postgres/postgres", title: "PostgreSQL", sources: ["official"] }),
  ];
  const rec = recommendServers(servers, { query: "" });
  assert.equal(rec[0].server.title, "GitHub MCP");
  assert.ok(rec.some((r) => r.server.title === "PostgreSQL"));
  const selected = pickSelectedServer(servers, rec, null);
  assert.equal(selected?.title, "GitHub MCP");
  assert.equal(pickSelectedServer(servers, rec, "ai.example/random")?.title, "Random");
});

test("sidebar split stays within IDE marketplace bounds", () => {
  assert.equal(clampSidebar(200), 320);
  assert.equal(clampSidebar(380), 380);
  assert.equal(clampSidebar(900), 520);
  assert.equal(overlaySidebar(400), true);
  assert.equal(overlaySidebar(639), true);
  assert.equal(overlaySidebar(640), false);
  assert.equal(overlaySidebar(800), false);
  assert.equal(overlaySidebar(1280), false);
  assert.equal(sidebarForContainer(500, 380), 240);
  assert.equal(sidebarForContainer(1280, 380), 380);
  assert.ok(sidebarForContainer(800, 520) <= 800 - 420 - 8);
});

test("catalog cards do not pretend a missing tools[] payload means zero tools", () => {
  const listing = sample({ name: "io.github.github/github-mcp-server", title: "GitHub MCP" });
  assert.equal(toolsAdvertisedLabel(listing), "tools listed after connect");
  const live = sample({ name: "GitHub", toolCount: 12, tools: [{ name: "create_pull_request", description: "PR", risk: "write" }] });
  assert.equal(toolsAdvertisedLabel(live), "12 tools");
});
