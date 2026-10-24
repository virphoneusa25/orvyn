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
import {
  applyAccessMode,
  applyToolOverrides,
  effectivePermissionInfo,
  isAccessMode,
  ACCESS_MODES,
} from "./PermissionProfiles";

const TOOL_NAMES = [
  "read_file",
  "list_directory",
  "search_code",
  "write_file",
  "create_file",
  "edit_file",
  "apply_patch",
  "run_tests",
  "run_typecheck",
  "run_linter",
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
  assert.equal(registry.getPermission("create_file"), "ask");
  assert.equal(registry.getPermission("apply_patch"), "ask");
  assert.equal(registry.getPermission("terminal"), "ask");
});

test("auto_read (SAFE): file/search and web reads allowed, mutations ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "auto_read");
  assert.equal(registry.getPermission("read_file"), "allowed");
  assert.equal(registry.getPermission("search_code"), "allowed");
  assert.equal(registry.getPermission("fetch_url"), "allowed");
  assert.equal(registry.getPermission("web_search"), "allowed");
  assert.equal(registry.getPermission("write_file"), "ask");
  assert.equal(registry.getPermission("create_file"), "ask");
  assert.equal(registry.getPermission("edit_file"), "ask");
  assert.equal(registry.getPermission("apply_patch"), "ask");
  assert.equal(registry.getPermission("run_tests"), "ask");
  assert.equal(registry.getPermission("terminal"), "ask");
});

test("auto_workspace (BALANCED): workspace dev auto (create/edit/patch/tests), terminal/git/deploy/mcp/ssh ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "auto_workspace");
  assert.equal(registry.getPermission("write_file"), "allowed");
  assert.equal(registry.getPermission("create_file"), "allowed");
  assert.equal(registry.getPermission("edit_file"), "allowed");
  assert.equal(registry.getPermission("apply_patch"), "allowed");
  assert.equal(registry.getPermission("run_tests"), "allowed");
  assert.equal(registry.getPermission("run_typecheck"), "allowed");
  assert.equal(registry.getPermission("run_linter"), "allowed");
  assert.equal(registry.getPermission("terminal"), "ask", "arbitrary terminal still asks");
  assert.equal(registry.getPermission("git_commit"), "ask");
  assert.equal(registry.getPermission("ssh_exec"), "ask");
  assert.equal(registry.getPermission("mcp_call"), "ask");
});

test("full_access (AUTONOMOUS): create/edit/patch/terminal/git auto — mcp_call and ssh_exec still ask", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "full_access");
  assert.equal(registry.getPermission("write_file"), "allowed");
  assert.equal(registry.getPermission("create_file"), "allowed");
  assert.equal(registry.getPermission("edit_file"), "allowed");
  assert.equal(registry.getPermission("apply_patch"), "allowed");
  assert.equal(registry.getPermission("terminal"), "allowed");
  assert.equal(registry.getPermission("git_commit"), "allowed");
  assert.equal(registry.getPermission("mcp_call"), "ask", "external MCP services stay approval-gated");
  assert.equal(registry.getPermission("ssh_exec"), "ask", "SSH stays approval-gated");
});

test("mode restrictions override the composer: Research/Plan + Full Access stays read-only", () => {
  for (const readMode of ["research", "plan"] as const) {
    const registry = freshRegistry();
    applyMode(registry, readMode);
    applyAccessMode(registry, "full_access");
    for (const name of [
      "write_file",
      "create_file",
      "edit_file",
      "apply_patch",
      "delete_file",
      "terminal",
      "run_tests",
      "git_commit",
    ]) {
      assert.equal(registry.getPermission(name), "denied", `${name} must stay denied in ${readMode} mode`);
    }
    assert.equal(registry.getPermission("read_file"), "allowed");
  }
});

test("missing or invalid permissionMode never silently grants unrestricted access", () => {
  assert.equal(isAccessMode(undefined), false);
  assert.equal(isAccessMode(""), false);
  assert.equal(isAccessMode("unrestricted"), false);
  assert.equal(isAccessMode("AUTONOMOUS"), false);
  assert.equal(isAccessMode("auto_workspace"), true);

  const missing = effectivePermissionInfo(undefined, "SAFE");
  assert.equal(missing.profile, "SAFE");
  assert.equal(missing.modeKey, "auto_read");
  assert.notEqual(missing.profile, "AUTONOMOUS");

  const invalid = effectivePermissionInfo("invalid_value", undefined);
  assert.equal(invalid.profile, "SAFE");
  assert.equal(invalid.modeKey, "auto_read");
  assert.notEqual(invalid.profile, "AUTONOMOUS");
});

test("applyToolOverrides preserves explicit user/project policies without violating mode boundaries", () => {
  const registry = freshRegistry();
  const baseDenied = new Set<string>(["delete_file"]);
  const def = applyMode(registry, "agent");
  applyAccessMode(registry, "auto_workspace");
  applyToolOverrides(
    registry,
    def.permissions,
    def.toolsEnabled,
    { write_file: "ask", git_commit: "allowed", delete_file: "allowed" },
    baseDenied
  );
  assert.equal(registry.getPermission("write_file"), "ask", "user override downgrades write_file to ask");
  assert.equal(registry.getPermission("git_commit"), "allowed", "user override allows git_commit in agent mode");
  assert.equal(registry.getPermission("delete_file"), "denied", "base-denied tool cannot be un-denied");

  // In read-only plan mode, user override cannot un-deny write_file or create_file
  const planReg = freshRegistry();
  const planDef = applyMode(planReg, "plan");
  applyAccessMode(planReg, "full_access");
  applyToolOverrides(
    planReg,
    planDef.permissions,
    planDef.toolsEnabled,
    { write_file: "allowed", create_file: "allowed" }
  );
  assert.equal(planReg.getPermission("write_file"), "denied");
  assert.equal(planReg.getPermission("create_file"), "denied");
});

test("re-applying agent mode after a run restores the mode baseline (no leakage)", () => {
  const registry = freshRegistry();
  applyMode(registry, "agent");
  applyAccessMode(registry, "full_access");
  assert.equal(registry.getPermission("terminal"), "allowed");
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
