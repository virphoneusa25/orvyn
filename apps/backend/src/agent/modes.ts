// apps/backend/src/agent/modes.ts
//
// Modes shape what the agent is allowed to do, not just how it's prompted.
// Prompting alone is not a safety boundary — a model told "don't edit files"
// will sometimes edit files anyway. Each mode therefore also carries a tool
// permission profile that is enforced by the tool registry.

import { ToolPermission, ToolRegistry } from "../ai/ToolTypes";

export type AgentMode = "agent" | "plan" | "debug" | "research" | "multitask" | "ask";

export interface ModeDefinition {
  id: AgentMode;
  label: string;
  description: string;
  /** Tool permissions applied for the duration of the run. */
  permissions: Record<string, ToolPermission>;
  systemPrompt: string;
  /** Ask runs with no tools at all. */
  toolsEnabled: boolean;
}

const READ_ONLY: Record<string, ToolPermission> = {
  read_document: "allowed",
  read_file: "allowed",
  list_directory: "allowed",
  search_files: "allowed",
  search_code: "allowed",
  search_codebase: "allowed",
  find_symbol: "allowed",
  find_file: "allowed",
  related_files: "allowed",
  search_tests: "allowed",
  get_project_outline: "allowed",
  list_symbols: "allowed",
  get_diagnostics: "allowed",
  read_process_logs: "allowed",
  list_processes: "allowed",
  git_status: "allowed",
  git_diff: "allowed",
  git_log: "allowed",
  git_branch: "allowed",
  fetch_url: "allowed",
  web_search: "allowed",
  mcp_list: "allowed",
  create_document: "denied",
  write_file: "denied",
  edit_file: "denied",
  move_file: "denied",
  delete_file: "denied",
  terminal: "denied",
  run_command: "denied",
  run_tests: "denied",
  run_typecheck: "denied",
  run_linter: "denied",
  start_process: "denied",
  stop_process: "denied",
  git_checkout: "denied",
  git_commit: "denied",
  generate_image: "denied",
  artifact_create: "denied",
  artifact_write: "denied",
  artifact_delete: "denied",
  artifact_list: "allowed",
  artifact_read: "allowed",
  artifact_get_download: "allowed",
  mcp_call: "denied",
  ssh_exec: "denied",
  browser_open: "denied",
  browser_navigate: "denied",
  browser_click: "denied",
  browser_type: "denied",
  browser_screenshot: "denied",
  browser_console_errors: "denied",
  desktop_start: "denied",
  desktop_open_url: "denied",
  desktop_click: "denied",
  desktop_type: "denied",
  desktop_scroll: "denied",
  desktop_key: "denied",
  desktop_screenshot: "denied",
  desktop_stop: "denied",
};

// Full-access profile shared by Agent and Multitask: reads are free, anything
// that mutates state or leaves the sandbox needs a per-call approval.
const FULL_WITH_APPROVAL: Record<string, ToolPermission> = {
  read_document: "allowed",
  read_file: "allowed",
  list_directory: "allowed",
  search_files: "allowed",
  search_code: "allowed",
  search_codebase: "allowed",
  find_symbol: "allowed",
  find_file: "allowed",
  related_files: "allowed",
  search_tests: "allowed",
  get_project_outline: "allowed",
  list_symbols: "allowed",
  get_diagnostics: "allowed",
  read_process_logs: "allowed",
  list_processes: "allowed",
  git_status: "allowed",
  git_diff: "allowed",
  git_log: "allowed",
  git_branch: "allowed",
  mcp_list: "allowed",
  create_document: "ask",
  write_file: "ask",
  edit_file: "ask",
  move_file: "ask",
  delete_file: "ask",
  terminal: "ask",
  run_command: "ask",
  run_tests: "ask",
  run_typecheck: "ask",
  run_linter: "ask",
  start_process: "ask",
  stop_process: "ask",
  fetch_url: "ask",
  web_search: "ask",
  git_checkout: "ask",
  git_commit: "ask",
  generate_image: "ask",
  artifact_create: "ask",
  artifact_write: "ask",
  artifact_delete: "ask",
  artifact_list: "allowed",
  artifact_read: "allowed",
  artifact_get_download: "allowed",
  mcp_call: "ask",
  ssh_exec: "ask",
  browser_open: "ask",
  browser_navigate: "ask",
  browser_click: "ask",
  browser_type: "ask",
  browser_screenshot: "ask",
  // Read-only report of already-collected errors — safe to auto-run.
  browser_console_errors: "allowed",
  desktop_start: "ask",
  desktop_open_url: "ask",
  desktop_click: "ask",
  desktop_type: "ask",
  desktop_scroll: "ask",
  desktop_key: "ask",
  desktop_screenshot: "ask",
  desktop_wait: "allowed",
  desktop_stop: "ask",
};

export const MODES: Record<AgentMode, ModeDefinition> = {
  agent: {
    id: "agent",
    label: "Agent",
    description: "Full access — reads, edits, and runs commands with approval",
    toolsEnabled: true,
    permissions: FULL_WITH_APPROVAL,
    systemPrompt: [
      "You are ORVYN's coding agent. Your job is to ship working changes — investigate, edit, verify — like Cursor's agent or Devin.",
      "NEVER greet the user, never ask 'how can I help', never reply with an offer of assistance, never end by inviting follow-up questions. Every turn must either use a tool or deliver a concrete result.",
      "If the request is vague, do NOT ask for clarification first — investigate: list the project, read the key files (entry points, configs, READMEs), then report what you found and do the most reasonable interpretation of the request.",
      "Work iteratively:",
      "1. Investigate before changing anything.",
      "2. Make the change.",
      "3. VERIFY it — run the build or tests via the terminal tool.",
      "4. If verification fails, diagnose the error and change approach.",
      "5. Finish only when done and verified, then summarise what changed and how it was verified.",
      "You can generate images with the generate_image tool when the user asks for artwork, icons, or mockups.",
    ].join("\n"),
  },

  plan: {
    id: "plan",
    label: "Plan",
    description: "Generate an implementation plan — investigates but never edits",
    toolsEnabled: true,
    // Read-only is enforced, not merely requested: Plan mode must be safe to
    // run on any repo without risk of modification.
    permissions: READ_ONLY,
    systemPrompt: [
      "You are in PLAN mode. Produce an implementation plan. You may read and",
      "search the codebase, but you CANNOT edit files or run commands.",
      "",
      "Investigate first, then output a plan containing:",
      "- The approach, and why it fits this codebase specifically",
      "- Ordered, concrete steps",
      "- Files that will need to change, and roughly how",
      "- Risks, edge cases, and anything you're unsure about",
      "",
      "Reference real file paths and symbols you actually found. Do not invent them.",
    ].join("\n"),
  },

  debug: {
    id: "debug",
    label: "Debug",
    description: "Pinpoint the root cause of an issue",
    toolsEnabled: true,
    permissions: {
      ...READ_ONLY,
      // Debugging usually needs to reproduce the failure, so the terminal is
      // available — but gated on approval, and writes stay denied so a debug
      // session can't silently "fix" things.
      terminal: "ask",
      run_command: "ask",
      run_tests: "ask",
      run_typecheck: "ask",
      run_linter: "ask",
    },
    systemPrompt: [
      "You are in DEBUG mode. Find the ROOT CAUSE. Do not apply fixes.",
      "",
      "Method:",
      "1. Reproduce or observe the failure (you may run commands with approval).",
      "2. Read the relevant code and trace the actual execution path.",
      "3. Form a hypothesis, then look for evidence that would disprove it.",
      "4. State the root cause with the specific file and line, and the evidence.",
      "5. Describe the fix you would make — but do not make it.",
      "",
      "If the evidence is inconclusive, say so and state what you'd need to check next.",
      "Do not guess confidently.",
    ].join("\n"),
  },

  research: {
    id: "research",
    label: "Research",
    description: "Investigate and report, no edits",
    toolsEnabled: true,
    permissions: READ_ONLY,
    systemPrompt: [
      "You are in RESEARCH mode. Investigate thoroughly and report findings.",
      "You may read files, search code, and fetch URLs — but you cannot edit anything.",
      "Report findings with concrete file paths, line references, and evidence.",
    ].join("\n"),
  },

  multitask: {
    id: "multitask",
    label: "Multitask",
    description: "Orchestrate subagents: planner decomposes, executor works, reviewer checks",
    toolsEnabled: true,
    permissions: FULL_WITH_APPROVAL,
    systemPrompt: "", // supplied by MultiAgentRuntime's own role prompts
  },

  ask: {
    id: "ask",
    label: "Ask",
    description: "Answer questions without making edits",
    toolsEnabled: false,
    permissions: {},
    systemPrompt: [
      "You are in ASK mode. Answer the user's question directly.",
      "You have no tools: rely on the attached context and conversation.",
      "If answering properly would require inspecting files you weren't given,",
      "say what you'd need rather than guessing.",
    ].join("\n"),
  },
};

/**
 * Maps the user-facing composer modes (Auto/Code/Server/Research/Deploy/
 * Automate) onto the backend agent modes that control actual tool policy.
 * This is the "real run modes" contract: each chip changes routing.
 */
export const MODE_CHIP_TO_AGENT: Record<string, AgentMode> = {
  auto: "agent",       // ORION chooses the workflow
  code: "agent",       // repository/files/tests focus (default agent mode)
  server: "debug",     // prefer SSH/server/log/service tools; read+terminal
  research: "research", // read/search focused, minimal mutations
  deploy: "multitask", // deployment tools enabled but approval-gated
  automate: "multitask", // workflow preparation
};

/** Applies a user-facing mode chip's tool policy. */
export function applyUserMode(registry: ToolRegistry, chip: string): ModeDefinition {
  return applyMode(registry, MODE_CHIP_TO_AGENT[chip] ?? "agent");
}

/** Applies a mode's permission profile to a tenant's tool registry. */
export function applyMode(registry: ToolRegistry, mode: AgentMode): ModeDefinition {
  const def = MODES[mode] ?? MODES.agent;
  if (!def.toolsEnabled) {
    for (const tool of registry.list()) {
      registry.setPermission(tool.name, "denied");
    }
    return def;
  }
  for (const [tool, permission] of Object.entries(def.permissions)) {
    registry.setPermission(tool, permission);
  }
  return def;
}
