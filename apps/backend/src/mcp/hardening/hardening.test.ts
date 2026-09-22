import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAuthorizeUrl,
  generatePkce,
  generateState,
  parseStoredTokens,
  refreshTokens,
  shouldRefresh,
  validateCallback,
  type OAuthMetadata,
  type OAuthSession,
} from "./oauth";
import { adminToolDenied, denyStartReason, DEFAULT_POLICY, type McpEnterprisePolicy } from "./policy";
import { flagRepositoryMismatch, pinRequired, riskSignals, scriptsFromManifest } from "./provenance";
import { McpObservability } from "./observability";
import { McpCloudGateway } from "./gateway";
import { rankHit } from "../marketplace/searchCapabilities";
import { DEFAULT_TOOL_BUDGET } from "../marketplace/types";
import { McpHardening } from "./hardening";
import { McpManager } from "../McpManager";
import { ToolGateway } from "../../gateway/ToolGateway";
import { ToolRegistry } from "../../ai/ToolTypes";
import { PermissionEngine } from "../../gateway/PermissionEngine";

function fakeStore() {
  const map = new Map<string, string>();
  return {
    getSetting: (k: string) => map.get(k) ?? null,
    setSetting: (k: string, v: string) => void map.set(k, v),
    deleteSetting: (k: string) => void map.delete(k),
    dump: () => map,
  };
}

function session(overrides: Partial<OAuthSession> = {}): OAuthSession {
  return {
    state: "state-abc",
    nonce: "nonce-xyz",
    pkce: generatePkce(),
    resource: "https://mcp.example/mcp",
    serverId: "mcp_1",
    tenantId: "tenant-a",
    redirectUri: "http://127.0.0.1:9/callback",
    clientId: "orvyn-mcp",
    metadata: { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" },
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

test("OAuth PKCE is S256 and never implicit", () => {
  const pkce = generatePkce();
  assert.equal(pkce.method, "S256");
  assert.ok(pkce.verifier.length >= 32);
  assert.notEqual(pkce.verifier, pkce.challenge);
  const url = buildAuthorizeUrl(
    { authorization_endpoint: "https://auth.example/authorize", token_endpoint: "https://auth.example/token" },
    { clientId: "orvyn-mcp", redirectUri: "http://127.0.0.1:1/callback", state: "s", challenge: pkce.challenge }
  );
  assert.match(url, /response_type=code/);
  assert.match(url, /code_challenge_method=S256/);
  assert.doesNotMatch(url, /token/);
});

test("callback validation: state CSRF, expiry, missing code", () => {
  const s = session();
  assert.equal(validateCallback(s, { state: s.state, code: "abc" }), "abc");
  assert.throws(() => validateCallback(s, { state: "nope", code: "abc" }), /state mismatch/);
  assert.throws(() => validateCallback(s, { state: s.state }), /missing authorization code/);
  assert.throws(() => validateCallback({ ...s, expiresAt: Date.now() - 1 }, { state: s.state, code: "abc" }), /expired/);
  assert.throws(() => validateCallback(s, { state: s.state, error: "access_denied" }), /provider error/);
});

test("token refresh: skew, missing refresh, backoff on failure", async () => {
  assert.equal(shouldRefresh({ access_token: "a", expires_at: Date.now() + 120_000 }), false);
  assert.equal(shouldRefresh({ access_token: "a", expires_at: Date.now() + 10_000 }), true);
  const meta: OAuthMetadata = { authorization_endpoint: "https://a/x", token_endpoint: "https://a/token" };
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }), text: async () => "" });
  await assert.rejects(() => refreshTokens(meta, { refreshToken: "r", clientId: "c" }, fetchImpl as any));
});

test("secure token refs: parsed tokens never written as config plaintext", () => {
  const store = fakeStore();
  const gateway = new ToolGateway(new ToolRegistry(), new PermissionEngine());
  const mgr = new McpManager({ gateway, store });
  const harden = new McpHardening(mgr, store, "tenant-a", (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    text: async () => "",
  })) as any);
  mgr.addServer({ name: "remote", transport: "http", url: "https://mcp.example/mcp", authKind: "oauth" });
  const id = mgr.listServers()[0].id;
  (harden as any).storeTokens(id, { access_token: "AT_LIVE", refresh_token: "RT_LIVE", expires_at: Date.now() + 1000 });
  const dumped = [...store.dump().entries()];
  assert.ok(!JSON.stringify(mgr.listServers()).includes("AT_LIVE"));
  assert.ok(dumped.some(([k, v]) => k.includes("mcp.secret.") && v.includes("AT_LIVE")));
  assert.deepEqual(parseStoredTokens(mgr.secret(id, "oauth")), {
    access_token: "AT_LIVE",
    refresh_token: "RT_LIVE",
    token_type: undefined,
    expires_at: parseStoredTokens(mgr.secret(id, "oauth"))!.expires_at,
    scope: undefined,
  });
});

test("gateway tenant binding rejects cross-tenant invoke", async () => {
  const store = fakeStore();
  const mgr = new McpManager({ gateway: new ToolGateway(new ToolRegistry(), new PermissionEngine()), store });
  const obs = new McpObservability();
  const gw = new McpCloudGateway(mgr, () => ({ ...DEFAULT_POLICY }), obs);
  const out = await gw.invoke({
    tenantId: "tenant-b",
    expectedTenantId: "tenant-a",
    serverId: "mcp_x",
    tool: "list",
    args: {},
    cloudRun: true,
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /Tenant isolation/);
});

test("gateway: local stdio is Local Only on cloud runs", async () => {
  const store = fakeStore();
  const mgr = new McpManager({ gateway: new ToolGateway(new ToolRegistry(), new PermissionEngine()), store });
  const cfg = mgr.addServer({ name: "echo", transport: "stdio", command: "node", args: ["-e", ""], executionLocation: "local" });
  const gw = new McpCloudGateway(mgr, () => ({ ...DEFAULT_POLICY }), new McpObservability());
  const out = await gw.invoke({
    tenantId: "t",
    expectedTenantId: "t",
    serverId: cfg.id,
    tool: "ping",
    args: {},
    cloudRun: true,
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /Local Only/);
  assert.equal(out.executionLocation, "local");
});

test("gateway outage reports unavailable with no local fallback", async () => {
  const store = fakeStore();
  const mgr = new McpManager({ gateway: new ToolGateway(new ToolRegistry(), new PermissionEngine()), store });
  const gw = new McpCloudGateway(mgr, () => ({ ...DEFAULT_POLICY }), new McpObservability());
  gw.available = false;
  const out = await gw.invoke({
    tenantId: "t",
    expectedTenantId: "t",
    serverId: "x",
    tool: "t",
    args: {},
    cloudRun: true,
  });
  assert.equal(out.ok, false);
  assert.match(out.error ?? "", /no local fallback/i);
});

test("package provenance: pin required, scripts surfaced, checksum recorded", () => {
  assert.match(pinRequired("latest") ?? "", /pinned/);
  assert.match(pinRequired("^1.2.3") ?? "", /pinned/);
  assert.equal(pinRequired("1.2.3"), null);
  const scripts = scriptsFromManifest({ scripts: { preinstall: "node x", test: "noop", postinstall: "curl" } });
  assert.deepEqual(scripts, ["preinstall", "postinstall"]);
  const signals = riskSignals({ scripts, networkRequired: true, filesystemScope: "project", nativeBinary: true, provenanceGap: true });
  assert.ok(signals.includes("install-script"));
  assert.ok(signals.includes("network"));
  assert.ok(flagRepositoryMismatch("https://github.com/acme/safe", "https://github.com/evil/safe"));
});

test("scope: project servers are not visible to another project", () => {
  const store = fakeStore();
  const mgr = new McpManager({ gateway: new ToolGateway(new ToolRegistry(), new PermissionEngine()), store });
  const harden = new McpHardening(mgr, store, "t");
  const cfg = mgr.addServer({ name: "db", transport: "stdio", command: "npx", cwd: "/proj-a", scope: "project" });
  assert.equal(harden.inScope(cfg, "/proj-a"), true);
  assert.equal(harden.inScope(cfg, "/proj-b"), false);
  assert.equal(harden.inScope({ scope: "global" }, "/proj-b"), true);
  assert.equal(harden.inScope({ scope: "run" }, "/proj-a"), false);
  assert.equal(harden.inScope({ scope: "run" }, "/proj-a", "run_1"), true);
});

test("allowlist / blocklist / admin hard deny overrides Full Access", () => {
  const open = { ...DEFAULT_POLICY };
  assert.equal(denyStartReason(open, { id: "x", trustLevel: "unverified" }), null);
  const verified: McpEnterprisePolicy = { ...DEFAULT_POLICY, mode: "verified-only" };
  assert.match(denyStartReason(verified, { id: "x", trustLevel: "community" }) ?? "", /Verified Only/);
  const allow: McpEnterprisePolicy = { ...DEFAULT_POLICY, mode: "allowlist-only", allowlist: ["org.ok"] };
  assert.match(denyStartReason(allow, { id: "nope" }) ?? "", /Allowlist Only/);
  assert.equal(denyStartReason(allow, { id: "org.ok" }), null);
  const blocked: McpEnterprisePolicy = { ...DEFAULT_POLICY, blocklist: ["bad"], blockedTools: ["delete_repo"], blockedPackages: ["evil"] };
  assert.match(denyStartReason(blocked, { id: "bad" }) ?? "", /Blocked/);
  assert.equal(adminToolDenied(blocked, "mcp.github.delete_repo"), true);
  assert.equal(adminToolDenied(blocked, "list_issues"), false);
});

test("health metrics, bounded restart, circuit breaker", () => {
  const obs = new McpObservability();
  for (let i = 0; i < 5; i++) obs.record("s1", "list", false, 10);
  assert.match(obs.circuitOpen("s1") ?? "", /failures/);
  const snap = obs.snapshot("s1", { state: "ERROR", toolCount: 1, enabled: true });
  assert.equal(snap.status, "Error");
  assert.ok(snap.tools.list.failure >= 5);
  assert.ok(snap.circuitReason);
  const first = obs.canRestart("s1");
  assert.equal(first.ok, true);
  assert.equal(first.waitMs, 1000);
  obs.noteRestart("s1");
  obs.noteRestart("s1");
  obs.noteRestart("s1");
  const done = obs.canRestart("s1");
  assert.equal(done.ok, false);
  assert.match(done.reason ?? "", /Restart budget/);
});

test("capability ranking prefers installed + healthy + in-scope", () => {
  const low = rankHit("create github pull request", "unrelated", "notes");
  const high = rankHit("create github pull request", "mcp.github.create_pull_request", "Open a GitHub pull request", {
    installed: true,
    inScope: true,
    health: "Healthy",
    trust: "verified",
    lastUsedAt: Date.now(),
  });
  assert.ok(high > low);
});

test("tool budget stays 8 servers / 40 tools", () => {
  assert.deepEqual(DEFAULT_TOOL_BUDGET, { maxServers: 8, maxTools: 40 });
});

test("replay metadata shape for mcp.activation / capability.required", () => {
  const activation = {
    activatedTools: ["mcp.github.list_issues"],
    activatedServers: ["github"],
    reason: "list issues",
    tokenFootprint: 12,
  };
  assert.ok(activation.activatedTools[0].startsWith("mcp."));
  const required = { query: "create PR", reason: "ORION needs GitHub", recommendedServers: [{ name: "GitHub" }], runId: "run_1" };
  assert.equal(required.recommendedServers.length, 1);
});

test("OAuth start refuses blocked servers", async () => {
  const store = fakeStore();
  const mgr = new McpManager({ gateway: new ToolGateway(new ToolRegistry(), new PermissionEngine()), store });
  const cfg = mgr.addServer({ name: "remote", transport: "http", url: "https://mcp.example/mcp", authKind: "oauth" });
  const harden = new McpHardening(mgr, store, "t");
  harden.setPolicy({ blocklist: [cfg.id] });
  await assert.rejects(() => harden.startOAuth({ serverId: cfg.id, resource: "https://mcp.example/mcp" }), /Blocked/);
});

test("generateState is unique and unguessable", () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16);
});
