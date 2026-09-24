import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { prepareRunPreflight } from "./runPreflightResult";
import type { RegisteredResource } from "./resourceResolver";

const TOOLS = ["read_file", "write_file", "terminal", "git_status", "ssh_exec", "mcp_list", "browser_open", "generate_image"];

function server(id: string, label: string, tenant = "t1"): RegisteredResource {
  return {
    resourceId: id,
    tenantId: tenant,
    organizationId: "o1",
    authorized: true,
    projectId: null,
    type: "server",
    capabilities: ["remote.shell"],
    status: "ready",
    labels: [label],
  };
}

test("no workspace blocks before any tool is offered", () => {
  const result = prepareRunPreflight({
    instruction: "Fix this project.",
    projectRoot: join(tmpdir(), "missing-orvyn-workspace"),
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [],
    toolNames: TOOLS,
    hasLocalProject: false,
    cloudControlPlane: false,
    cloudWorkspaceAvailable: false,
  });
  assert.equal(result.canExecute, false);
  assert.equal(result.relevantTools.includes("git_status"), false);
  assert.equal(result.relevantTools.includes("mcp_list"), false);
});

test("a cloud website with no local folder targets the cloud worker", () => {
  const result = prepareRunPreflight({
    instruction: "Build me a website.",
    projectRoot: join(tmpdir(), "no-local-site"),
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [],
    toolNames: TOOLS,
    hasLocalProject: false,
    cloudControlPlane: true,
    cloudWorkspaceAvailable: true,
  });
  assert.equal(result.canExecute, true);
  assert.equal(result.executionTarget, "cloud_worker");
  assert.equal(result.relevantTools.includes("ssh_exec"), false);
  assert.equal(result.relevantTools.includes("mcp_list"), false);
});

test("a local repository keeps git tools and stays on the host", () => {
  const root = mkdtempSync(join(tmpdir(), "orvyn-repo-"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, "README"), "x");
  const result = prepareRunPreflight({
    instruction: "Fix the failing tests.",
    projectRoot: root,
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [],
    toolNames: TOOLS,
    hasLocalProject: true,
    cloudControlPlane: false,
    cloudWorkspaceAvailable: false,
  });
  assert.equal(result.workspace.repositoryDetected, true);
  assert.equal(result.executionTarget, "local_host");
  assert.equal(result.relevantTools.includes("git_status"), true);
  assert.equal(result.relevantTools.includes("mcp_list"), false);
});

test("no server blocks a remote check, and two servers are not guessed", () => {
  const none = prepareRunPreflight({
    instruction: "Check the service on the server.",
    projectRoot: tmpdir(),
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [],
    toolNames: TOOLS,
    hasLocalProject: false,
    cloudControlPlane: true,
    cloudWorkspaceAvailable: true,
  });
  assert.equal(none.canExecute, false);
  assert.match(none.blockers.join(" "), /server/i);
  const many = prepareRunPreflight({
    instruction: "Check my server.",
    projectRoot: tmpdir(),
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [server("a", "production"), server("b", "staging")],
    toolNames: TOOLS,
    hasLocalProject: false,
    cloudControlPlane: true,
    cloudWorkspaceAvailable: true,
  });
  assert.equal(many.canExecute, false);
  assert.equal(many.resources.status, "blocked");
});

test("another tenant's server is not a match", () => {
  const result = prepareRunPreflight({
    instruction: "Check the staging server.",
    projectRoot: tmpdir(),
    tenantId: "t1",
    organizationId: "o1",
    projectId: null,
    resources: [server("foreign", "staging", "t2")],
    toolNames: TOOLS,
    hasLocalProject: false,
    cloudControlPlane: true,
    cloudWorkspaceAvailable: true,
  });
  assert.equal(result.canExecute, false);
});
