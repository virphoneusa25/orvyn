import { test } from "node:test";
import assert from "node:assert/strict";
import os from "os";
import path from "path";
import { mkdirSync, writeFileSync } from "fs";
import { inferTaskIntent } from "./taskIntent";
import { inspectWorkspace } from "./workspaceContext";
import { evaluatePreflight } from "./runPreflight";
import { selectToolNames } from "./toolPolicy";

test("a diagnosis with no repository and no server is blocked before tools", () => {
  const intent = inferTaskIntent("Diagnose a failing service");
  const workspace = inspectWorkspace(path.join(os.tmpdir(), "orvyn-missing-workspace"));
  const result = evaluatePreflight({ intent, workspace, servers: [] });
  assert.equal(result.status, "blocked");
  assert.match(result.message ?? "", /project, server, or environment/i);
  const tools = selectToolNames(
    ["git_status", "mcp_list", "read_file", "terminal"],
    intent,
    { repositoryDetected: false }
  );
  assert.equal(tools.includes("git_status"), false);
  assert.equal(tools.includes("mcp_list"), false);
  assert.equal(tools.includes("read_file"), true);
});

test("a diagnosis inside a repository is allowed", () => {
  const root = path.join(os.tmpdir(), `orvyn-repo-${Date.now()}`);
  mkdirSync(path.join(root, ".git"), { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  const intent = inferTaskIntent("Diagnose a failing service");
  mkdirSync(path.join(root, "nested"), { recursive: true });
  const found = inspectWorkspace(path.join(root, "nested"));
  assert.equal(found.repositoryDetected, true);
  assert.equal(found.repositoryRoot, root);
  assert.equal(evaluatePreflight({ intent, workspace: found, servers: [] }).status, "ok");
});

test("an ordinary question is not blocked for lack of a repo", () => {
  const intent = inferTaskIntent("What is a load balancer?");
  const workspace = inspectWorkspace(path.join(os.tmpdir(), "orvyn-missing-workspace"));
  assert.equal(evaluatePreflight({ intent, workspace, servers: [] }).status, "ok");
});
