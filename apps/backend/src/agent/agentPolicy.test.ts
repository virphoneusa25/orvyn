import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { inferTaskIntent } from "./taskIntent";
import { resolveResources, resourcesFromProject, type RegisteredResource } from "./resourceResolver";
import { selectToolNames, validateToolArguments } from "./toolPolicy";
import { evaluateCompletionGates } from "./completionGates";

const scope = { tenantId: "tenant-a", organizationId: "org-a", projectId: "proj-1" };

function server(alias: string, tenantId = "tenant-a"): RegisteredResource {
  return {
    resourceId: `server:${alias}`,
    tenantId,
    organizationId: "org-a",
    authorized: true,
    projectId: "proj-1",
    type: "server",
    capabilities: ["remoteShell"],
    status: "ready",
    labels: [alias],
  };
}

test("a conceptual question stays informational", () => {
  const intent = inferTaskIntent("What is a closure in JavaScript?");
  assert.equal(intent.informational, true);
  assert.equal(intent.category, "general");
  assert.equal(intent.requiresRemoteResource, false);
});

test("a capability question is not a server task", () => {
  const intent = inferTaskIntent("What can you actually do? Can you co-work?");
  assert.equal(intent.informational, true);
  assert.equal(intent.requiresRemoteResource, false);
});

test("server work asks for a remote resource and does not name a customer", () => {
  const intent = inferTaskIntent("Log into my configured test server and tell me its hostname and uptime.");
  assert.equal(intent.category, "server");
  assert.equal(intent.requiresRemoteResource, true);
  assert.equal(intent.informational, false);
});

test("missing server blocks before any tool call", () => {
  const intent = inferTaskIntent("check my server");
  const result = resolveResources({ intent, instruction: "check my server", ...scope, resources: [] });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.equal(result.code, "RESOURCE_REQUIRED");
    assert.match(result.message, /Connect a server/);
  }
});

test("two servers are not guessed", () => {
  const intent = inferTaskIntent("check my server");
  const result = resolveResources({
    intent,
    instruction: "check my server",
    ...scope,
    resources: [server("production"), server("staging")],
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") {
    assert.equal(result.code, "RESOURCE_AMBIGUOUS");
    assert.deepEqual(result.choices, ["production", "staging"]);
  }
});

test("a named server is selected and another tenant's server is ignored", () => {
  const intent = inferTaskIntent("check the staging server");
  const result = resolveResources({
    intent,
    instruction: "check the staging server",
    ...scope,
    resources: [server("production"), server("staging"), server("staging", "tenant-b")],
  });
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.equal(result.resources.length, 1);
    assert.equal(result.resources[0]!.resourceId, "server:staging");
    assert.equal(result.resources[0]!.tenantId, "tenant-a");
  }
});

test("project ssh config becomes aliases only", () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-res-"));
  mkdirSync(join(root, ".orvyn"));
  writeFileSync(join(root, ".orvyn", "ssh.json"), JSON.stringify({
    hosts: [{ alias: "lab", host: "203.0.113.10", user: "root", keyPath: "/secret/key" }],
  }));
  const resources = resourcesFromProject(root, scope);
  assert.equal(resources.length, 1);
  assert.equal(resources[0]!.labels[0], "lab");
  assert.equal(JSON.stringify(resources).includes("203.0.113.10"), false);
  assert.equal(JSON.stringify(resources).includes("secret"), false);
});

test("empty ssh host never validates", () => {
  const bad = validateToolArguments("ssh_exec", { host: "", command: "hostname" });
  assert.equal(bad.ok, false);
  const missing = validateToolArguments("ssh_exec", { command: "uptime" });
  assert.equal(missing.ok, false);
  const ok = validateToolArguments("remote_exec", { resourceId: "server:lab", command: "uptime" });
  assert.equal(ok.ok, true);
});

test("server tasks do not see image tools, and code tasks do not see ssh", () => {
  const names = ["read_file", "ssh_exec", "generate_image", "browser_open", "desktop_click", "mcp_call", "terminal"];
  const serverTools = selectToolNames(names, inferTaskIntent("check my server"));
  assert.ok(serverTools.includes("ssh_exec"));
  assert.equal(serverTools.includes("generate_image"), false);
  const codeTools = selectToolNames(names, inferTaskIntent("Fix the failing test"));
  assert.equal(codeTools.includes("ssh_exec"), false);
  assert.ok(codeTools.includes("terminal"));
  assert.ok(codeTools.includes("read_file"));
});

test("a server run cannot complete without a remote result", () => {
  const blocked = evaluateCompletionGates({
    instruction: "check my server",
    category: "server",
    artifacts: [],
    events: [{ type: "tool.completed", data: { tool: "read_file" } }],
  });
  assert.equal(blocked.ok, false);
  assert.match(blocked.retryPrompt, /ssh_exec|remote_exec/);
  const passed = evaluateCompletionGates({
    instruction: "check my server",
    category: "server",
    artifacts: [],
    events: [{ type: "tool.completed", data: { tool: "ssh_exec" } }],
  });
  assert.equal(passed.ok, true);
});
