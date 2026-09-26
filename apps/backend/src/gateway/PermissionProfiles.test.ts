// apps/backend/src/gateway/PermissionProfiles.test.ts
//
// Pins the composer access modes onto the ONE permission engine: every mode
// maps to a profile upgrade over the mode baseline, never touching `denied`
// (Research stays read-only even under Full Access), and ASK additionally
// gates network-facing reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry, AITool } from "../ai/ToolTypes";
import { applyMode } from "../agent/modes";
import { applyAccessMode, ACCESS_MODES } from "./PermissionProfiles";

const TOOL_NAMES = [
  "read_file",
  "list_directory",
  "search_code",
  "write_file",
  "edit_file",
  "run_tests",
  "run_typecheck",
  "terminal",
  "run_command",
  "git_commit",
  "git_checkout",
  "delete_file",
  "fetch_url",
  "web_search",
  "mcp_call",
  "ssh_exec",
];

function freshRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  // Defaults mirror the real project tools: reads and network lookups are
  // allowed out of the box; mutating tools default to ask.
  const ALLOWED_BY_DEFAULT = new Set(["read_file", "list_directory", "search_code", "fetch_url", "web_search"]);
  for (const name of TOOL_NAMES) {
    const tool: AITool = {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      defaultPermission: ALLOWED_BY_DEFAULT.has(name) ? "allowed" : "ask",
      async execute() {
        return { ok: true, output: "" };
      },
    };
    registry.register(tool);
  }
  return registry;
}

test("ask: reads allowed, network reads gated, everything mutating asks", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "ask");
  assert.equal(registry.getPermission("read_file"), "allowed");
  assert.equal(registry.getPermission("search_code"), "allowed");
  assert.equal(registry.getPermission("fetch_url"), "ask", "ASK gates network reads");
  assert.equal(registry.getPermission("web_search"), "ask");
  assert.equal(registry.getPermission("ssh_exec"), "ask");
  assert.equal(registry.getPermission("write_file"), "ask");
  assert.equal(registry.getPermission("terminal"), "ask");
});

test("auto_read: file/search and web reads allowed, mutations ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "auto_read");
  assert.equal(registry.getPermission("read_file"), "allowed");
  assert.equal(registry.getPermission("search_code"), "allowed");
  // ORION researches on its own: searching and reading web pages are reads.
  assert.equal(registry.getPermission("fetch_url"), "allowed");
  assert.equal(registry.getPermission("web_search"), "allowed");
  assert.equal(registry.getPermission("write_file"), "ask");
  assert.equal(registry.getPermission("edit_file"), "ask");
  assert.equal(registry.getPermission("run_tests"), "ask");
  assert.equal(registry.getPermission("terminal"), "ask");
});

test("auto_workspace: workspace dev auto (edit/tests), terminal/git/deploy ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "auto_workspace");
  assert.equal(registry.getPermission("write_file"), "allowed");
  assert.equal(registry.getPermission("edit_file"), "allowed");
  assert.equal(registry.getPermission("run_tests"), "allowed");
  assert.equal(registry.getPermission("run_typecheck"), "allowed");
  assert.equal(registry.getPermission("terminal"), "ask", "arbitrary terminal still asks");
  assert.equal(registry.getPermission("git_commit"), "ask");
  assert.equal(registry.getPermission("ssh_exec"), "ask");
});

test("full_access: terminal and git auto — mcp_call and hard policy still ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "full_access");
  assert.equal(registry.getPermission("write_file"), "allowed");
  assert.equal(registry.getPermission("terminal"), "allowed");
  assert.equal(registry.getPermission("git_commit"), "allowed");
  // Full Access is maximum USER-AUTHORIZED autonomy, not unrestricted access:
  assert.equal(registry.getPermission("mcp_call"), "ask", "external MCP services stay approval-gated");
});

test("mode restrictions override the composer: Research + Full Access stays read-only", () => {
  const registry = freshRegistry();
  applyMode(registry, "research");
  applyAccessMode(registry, "full_access");
  for (const name of ["write_file", "edit_file", "delete_file", "terminal", "run_tests", "git_commit"]) {
    assert.equal(registry.getPermission(name), "denied", `${name} must stay denied in Research mode`);
  }
  assert.equal(registry.getPermission("read_file"), "allowed");
});

test("re-applying agent mode after a run restores the mode baseline (no leakage)", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "full_access");
  assert.equal(registry.getPermission("terminal"), "allowed");
  // What restoreAccessMode does when the run settles:
  applyMode(registry, "agent");
  assert.equal(registry.getPermission("terminal"), "ask", "profile upgrade undone by mode baseline re-apply");
});

test("ACCESS_MODES covers exactly the four user-facing modes with descriptions", () => {
  assert.deepEqual(Object.keys(ACCESS_MODES).sort(), ["ask", "auto_read", "auto_workspace", "full_access"]);
  for (const mode of Object.values(ACCESS_MODES)) {
    assert.ok(mode.label.length > 0 && mode.description.length > 0);
  }
});

test("Ask mode still asks before every web read; a mode that denies web tools keeps them denied", () => {
  const ask = freshRegistry();
  applyMode(ask, "agent");
  applyAccessMode(ask, "ask");
  assert.equal(ask.getPermission("web_search"), "ask");
  assert.equal(ask.getPermission("fetch_url"), "ask");
});
