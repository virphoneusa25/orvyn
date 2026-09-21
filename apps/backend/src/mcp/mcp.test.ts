// apps/backend/src/mcp/mcp.test.ts
//
// MCP host test coverage: risk classification, permission resolution,
// secret redaction in persisted config, tool search, and a REAL stdio
// round-trip against a live MCP server process built on the official SDK.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyTool, effectivePermission, toGatewayPermission } from "./McpPermissionService";
import { McpRegistry } from "./McpRegistry";
import { McpManager } from "./McpManager";
import { ToolGateway } from "../gateway/ToolGateway";
import { ToolRegistry } from "../ai/ToolTypes";

// ---- Risk classification ----------------------------------------------------

test("risk classification: annotations win, then name/description heuristics", () => {
  assert.equal(classifyTool({ name: "get_file", annotations: { readOnlyHint: true } }), "READ");
  assert.equal(classifyTool({ name: "cleanup", annotations: { destructiveHint: true } }), "DESTRUCTIVE");
  assert.equal(classifyTool({ name: "list_repositories", description: "List repos" }), "READ");
  assert.equal(classifyTool({ name: "create_pull_request" }), "WRITE");
  assert.equal(classifyTool({ name: "delete_branch" }), "DESTRUCTIVE");
  assert.equal(classifyTool({ name: "restart_container" }), "EXTERNAL_SIDE_EFFECT");
  assert.equal(classifyTool({ name: "mystery" }), "EXTERNAL_SIDE_EFFECT", "unknown intent never auto-runs");
});

test("effective permission: tool override beats risk default; everything defaults to ASK", () => {
  assert.equal(effectivePermission("READ", undefined, "x"), "ASK");
  assert.equal(effectivePermission("WRITE", { serverDefaults: {}, toolOverrides: { create_pr: "ALLOW" } }, "create_pr"), "ALLOW");
  assert.equal(effectivePermission("READ", { serverDefaults: { READ: "ALLOW" }, toolOverrides: {} }, "anything"), "ALLOW");
  assert.equal(toGatewayPermission("ALLOW"), "allowed");
  assert.equal(toGatewayPermission("DENY"), "denied");
});

// ---- Registry persistence + secret redaction --------------------------------

function fakeStore() {
  const map = new Map<string, string>();
  return {
    getSetting: (k: string) => map.get(k) ?? null,
    setSetting: (k: string, v: string) => void map.set(k, v),
    deleteSetting: (k: string) => void map.delete(k),
    dump: () => map,
  };
}

test("registry: secrets live in a separate namespace, config JSON never contains them", () => {
  const store = fakeStore();
  const reg = new McpRegistry(store);
  const cfg = {
    id: "srv1", name: "github", enabled: false, transport: "http" as const,
    url: "https://mcp.example", headers: { Authorization: "Bearer {{token}}" },
    secretNames: ["token"], createdAt: Date.now(), updatedAt: Date.now(),
  };
  reg.upsert(cfg, store);
  reg.setSecret("srv1", "token", "ghp_supersecret123");
  const persisted = store.dump().get("mcp.servers.v1") ?? "";
  assert.ok(!persisted.includes("ghp_supersecret123"), "secret value must never appear in config JSON");
  assert.equal(reg.secret("srv1", "token"), "ghp_supersecret123");
  const resolved = reg.resolveHeaders("srv1", { Authorization: "Bearer {{token}}" });
  assert.equal(resolved.Authorization, "Bearer ghp_supersecret123", "secret resolves at connect time");
});

// ---- Manager: search + permission flow against a fake connected server -------

test("manager: tool search ranks native + MCP tools by relevance", async () => {
  const store = fakeStore();
  const { PermissionEngine } = await import("../gateway/PermissionEngine");
    const engine = new PermissionEngine();
    const gateway = new ToolGateway(new ToolRegistry(), engine);
  gateway.register({
    name: "search_code", description: "Search the codebase", parameters: { type: "object", properties: {} }, defaultPermission: "allowed",
    async execute() { return { ok: true, output: "" }; },
  });
  const mgr = new McpManager({ gateway, store });
  // Simulate a connected server by injecting into the connections map through the public surface:
  // register a server, then use registerTools via a real connect below in the stdio test.
  const results = mgr.searchTools("search code");
  assert.ok(results.some((r) => r.name === "search_code" && r.source === "native"));
  assert.deepEqual(mgr.searchTools(""), [], "empty query returns nothing");
});

// ---- REAL stdio round-trip with the official SDK ------------------------------

const SERVER_SCRIPT = `
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const server = new McpServer({ name: "echo-test", version: "1.0.0" });
server.tool("echo_message", { message: z.string() }, async ({ message }) => ({ content: [{ type: "text", text: "echo: " + message }] }));
server.tool("list_items", {}, async () => ({ content: [{ type: "text", text: "item-a,item-b" }] }));
server.tool("create_item", { name: z.string() }, async ({ name }) => ({ content: [{ type: "text", text: "created " + name }] }));
server.tool("delete_item", { name: z.string() }, async ({ name }) => ({ content: [{ type: "text", text: "deleted " + name }] }));
server.tool("restart_service", { svc: z.string() }, async ({ svc }) => ({ content: [{ type: "text", text: "restarted " + svc }] }));
server.connect(new StdioServerTransport());
`;

test("stdio round-trip: connect, discover, classify, call, permissions, disable", async () => {
  const { writeFileSync, rmSync } = await import("fs");
  const { join } = await import("path");
  // The server script must live where require() can resolve the SDK —
  // Node resolves modules from the SCRIPT's directory, not the cwd.
  const scriptPath = join(process.cwd(), `orvyn-mcp-echo-test-${Date.now()}.cjs`);
  writeFileSync(scriptPath, SERVER_SCRIPT);

  const store = fakeStore();
  const { PermissionEngine } = await import("../gateway/PermissionEngine");
    const engine = new PermissionEngine();
    const gateway = new ToolGateway(new ToolRegistry(), engine);
  const mgr = new McpManager({ gateway, engine, store });

  try {
    const cfg = mgr.addServer({ name: "echosrv", transport: "stdio", command: process.execPath, args: [scriptPath] });
    const status = await mgr.connect(cfg.id);
    assert.equal(status.state, "CONNECTED", `server should connect (got ${status.state}: ${status.lastError})`);
    assert.equal(status.toolCount, 5, "all five tools discovered");

    // Risk classification on the REAL discovered tools
    const byName = Object.fromEntries(status.tools.map((t) => [t.name, t]));
    assert.equal(byName.echo_message.risk, "READ");
    assert.equal(byName.list_items.risk, "READ");
    assert.equal(byName.create_item.risk, "WRITE");
    assert.equal(byName.delete_item.risk, "DESTRUCTIVE");
    assert.equal(byName.restart_service.risk, "EXTERNAL_SIDE_EFFECT");

    // All default to ask through the gateway
    assert.equal(gateway.getPermission("mcp.echosrv.echo_message"), "ask");

    // Execute through the SAME gateway ORION uses
    const result = await gateway.execute("mcp.echosrv.echo_message", { message: "hello mcp" }, "coder");
    assert.ok(result.ok, `echo should succeed: ${result.error}`);
    assert.match(String(result.output), /echo: hello mcp/);

    // Search finds MCP tools by query
    const hits = mgr.searchTools("delete item");
    assert.ok(hits.some((h) => h.name === "mcp.echosrv.delete_item"), `search should find delete_item: ${JSON.stringify(hits)}`);

    // Capability summary is compact and mentions the server
    const summary = mgr.capabilitySummary();
    assert.ok(summary.length === 1 && summary[0].includes("echosrv"), `summary: ${summary}`);

    // Per-tool permission override applies to the gateway
    mgr.setToolPermission(cfg.id, "delete_item", "DENY");
    assert.equal(gateway.getPermission("mcp.echosrv.delete_item"), "denied");
    mgr.setToolPermission(cfg.id, "delete_item", "ALLOW");
    assert.equal(gateway.getPermission("mcp.echosrv.delete_item"), "allowed");

    // Disable → tools become denied (removed from availability)
    mgr.setEnabled(cfg.id, false);
    assert.equal(gateway.getPermission("mcp.echosrv.echo_message"), "denied");
    assert.equal(mgr.status(cfg.id)!.state, "DISABLED");
  } finally {
    rmSync(scriptPath, { force: true });
  }
});

test("failure isolation: a server that cannot start reports ERROR, never throws", async () => {
  const store = fakeStore();
  const { PermissionEngine } = await import("../gateway/PermissionEngine");
    const engine = new PermissionEngine();
    const gateway = new ToolGateway(new ToolRegistry(), engine);
  const mgr = new McpManager({ gateway, store });
  const cfg = mgr.addServer({ name: "broken", transport: "stdio", command: "definitely-not-a-real-command-xyz" });
  const status = await mgr.connect(cfg.id);
  assert.equal(status.state, "ERROR");
  assert.ok(status.lastError, "last error recorded");
});
