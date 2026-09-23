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

/**
 * Composer access modes (user-facing). They map onto the EXISTING profiles —
 * no second permission engine. ASK additionally downgrades network-facing
 * reads to per-call approval, making it the most approval-heavy mode.
 */
export type AccessMode = "ask" | "auto_read" | "auto_workspace" | "full_access";

export const ACCESS_MODES: Record<AccessMode, { profile: PermissionProfile; label: string; description: string }> = {
  ask: {
    profile: "SAFE",
    label: "Ask",
    description: "Confirm write/command actions",
  },
  auto_read: {
    profile: "SAFE",
    label: "Auto Read",
    description: "Read/search automatically",
  },
  auto_workspace: {
    profile: "BALANCED",
    label: "Auto Workspace",
    description: "Workspace development automatically",
  },
  full_access: {
    profile: "AUTONOMOUS",
    label: "Full Access",
    description: "Maximum permitted autonomy",
  },
};

/** Tools ASK additionally gates: reaching beyond the machine is not a plain
 *  "read" even when the capability class says NETWORK — the most
 *  approval-heavy mode asks for those too. */
const ASK_DOWNGRADE = new Set([
  "fetch_url",
  "web_search",
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "browser_console_errors",
  "browser_evidence",
  "desktop_start",
  "desktop_open_url",
  "desktop_click",
  "desktop_type",
  "desktop_scroll",
  "desktop_key",
  "desktop_screenshot",
  "desktop_stop",
  "mcp_call",
  "ssh_exec",
]);

export function isAccessMode(v: unknown): v is AccessMode {
  return typeof v === "string" && v in ACCESS_MODES;
}

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
  "create_zip",
  "artifact_create",
  "artifact_write",
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
  "artifact_delete",
  "browser_open",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_screenshot",
  "desktop_start",
  "desktop_open_url",
  "desktop_click",
  "desktop_type",
  "desktop_scroll",
  "desktop_key",
  "desktop_screenshot",
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
  // SAFE pre-approves nothing and downgrades nothing: a tool's permission is
  // whatever the MODE baseline gave it (undoing a prior profile's upgrades is
  // the mode re-application's job, not the profile's — blanket downgrading
  // here would also kill natively-allowed tools like web search).
  if (profile === "SAFE") return;
  const allow = ALLOW[profile];
  for (const tool of registry.list()) {
    if (allow.has(tool.name) && registry.getPermission(tool.name) === "ask") {
      registry.setPermission(tool.name, "allowed");
    }
  }
}

/**
 * Applies a composer access mode: the mode's profile upgrades, plus the ASK
 * downgrade for network-facing tools. Call AFTER applyMode() — profiles only
 * upgrade ask→allowed and never touch denied, so a read-only mode (Research)
 * stays read-only no matter what the composer says.
 */
export function applyAccessMode(registry: ToolRegistry, mode: AccessMode): void {
  const conf = ACCESS_MODES[mode];
  applyProfile(registry, conf.profile);
  if (mode === "ask") {
    for (const tool of registry.list()) {
      if (ASK_DOWNGRADE.has(tool.name) && registry.getPermission(tool.name) === "allowed") {
        registry.setPermission(tool.name, "ask");
      }
    }
  }
}
