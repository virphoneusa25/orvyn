// apps/backend/src/gateway/PermissionProfiles.ts
//
// User-selected autonomy profiles (spec §47). Composition rule, in order:
//
//   mode permissions  →  profile upgrades  →  explicit per-tool user overrides
//
// A profile may only upgrade `ask` → `allowed` for tools on its allow-list.
// It never touches `denied` — Plan mode stays read-only under AUTONOMOUS, and
// a tool the user explicitly denied stays denied. Hard boundaries that no
// profile can remove:
//   - destructive terminal commands always require approval (enforced in the
//     runtimes, independent of the stored permission),
//   - the project-root sandbox,
//   - agent-role capability checks (PermissionEngine).

import { ToolRegistry } from "../ai/ToolTypes";

export type PermissionProfile = "SAFE" | "BALANCED" | "AUTONOMOUS";

export const PROFILES: Record<PermissionProfile, { label: string; description: string }> = {
  SAFE: {
    label: "Safe",
    description: "Read freely; ask before every write, execution, network, or git action.",
  },
  BALANCED: {
    label: "Balanced",
    description: "Normal coding operations (edits, tests, typecheck, lint) run without prompts; destructive, network, terminal, and git actions still ask.",
  },
  AUTONOMOUS: {
    label: "Autonomous",
    description: "Project-sandboxed operations run without prompts, including terminal and git commit. Destructive commands and MCP calls still ask. Never pushes.",
  },
};

// Tools each profile pre-approves. SAFE pre-approves nothing.
const BALANCED_ALLOW = new Set([
  "create_document",
  "write_file",
  "edit_file",
  "move_file",
  "run_tests",
  "run_typecheck",
  "run_linter",
]);

const AUTONOMOUS_ALLOW = new Set([
  ...BALANCED_ALLOW,
  "delete_file",
  "terminal",
  "run_command",
  "start_process",
  "stop_process",
  "fetch_url",
  "web_search",
  "git_checkout",
  "git_commit",
  "generate_image",
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  // Deliberately NOT here: mcp_call (external services stay approval-gated).
]);

const ALLOW: Record<PermissionProfile, Set<string>> = {
  SAFE: new Set(),
  BALANCED: BALANCED_ALLOW,
  AUTONOMOUS: AUTONOMOUS_ALLOW,
};

/**
 * Upgrade `ask` → `allowed` for the profile's allow-listed tools. Call AFTER
 * applyMode() (so the mode's boundary stands) and BEFORE restoring explicit
 * user per-tool overrides (so the user still has the last word).
 */
export function applyProfile(registry: ToolRegistry, profile: PermissionProfile): void {
  if (profile === "SAFE") return;
  const allow = ALLOW[profile];
  for (const tool of registry.list()) {
    if (allow.has(tool.name) && registry.getPermission(tool.name) === "ask") {
      registry.setPermission(tool.name, "allowed");
    }
  }
}
