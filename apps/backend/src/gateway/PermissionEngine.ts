// apps/backend/src/gateway/PermissionEngine.ts
//
// Capability layer on top of the per-tool allowed/ask/denied registry.
// Tool-name permissions answer "may this project run this tool at all";
// capabilities answer "may this AGENT ROLE touch this class of resource".
// Both must pass. Agents cannot bypass this — the Tool Gateway is the only
// execution path and it consults this engine on every call.

export type Capability =
  | "READ"
  | "WRITE"
  | "DELETE"
  | "EXECUTE"
  | "NETWORK"
  | "GIT"
  | "DATABASE"
  | "DEPLOYMENT"
  | "SYSTEM";

export type AgentRole =
  | "orchestrator"
  | "coder"
  | "tester"
  | "browser"
  | "security"
  | "research"
  | "git";

/** Which capability class each tool belongs to. Unknown tools are SYSTEM (most restricted). */
const TOOL_CAPABILITIES: Record<string, Capability[]> = {
  read_document: ["READ"],
  create_document: ["WRITE"],
  read_file: ["READ"],
  list_directory: ["READ"],
  search_files: ["READ"],
  search_code: ["READ"],
  search_codebase: ["READ"],
  find_symbol: ["READ"],
  find_file: ["READ"],
  related_files: ["READ"],
  search_tests: ["READ"],
  get_project_outline: ["READ"],
  list_symbols: ["READ"],
  get_diagnostics: ["READ", "EXECUTE"],
  write_file: ["WRITE"],
  edit_file: ["WRITE"],
  move_file: ["WRITE"],
  delete_file: ["DELETE"],
  terminal: ["EXECUTE"],
  run_command: ["EXECUTE"],
  run_tests: ["EXECUTE"],
  run_typecheck: ["EXECUTE"],
  run_linter: ["EXECUTE"],
  start_process: ["EXECUTE"],
  stop_process: ["EXECUTE"],
  read_process_logs: ["READ"],
  list_processes: ["READ"],
  fetch_url: ["NETWORK"],
  web_search: ["NETWORK"],
  // Remote execution — strictly more dangerous than either class alone.
  ssh_exec: ["EXECUTE", "NETWORK"],
  browser_open: ["NETWORK", "EXECUTE"],
  browser_navigate: ["NETWORK"],
  browser_click: ["NETWORK"],
  browser_type: ["NETWORK"],
  browser_screenshot: ["NETWORK"],
  browser_console_errors: ["NETWORK"],
  browser_scroll: ["NETWORK"],
  browser_evidence: ["NETWORK"],
  desktop_start: ["NETWORK", "EXECUTE"],
  desktop_open_url: ["NETWORK"],
  desktop_click: ["NETWORK"],
  desktop_move: ["NETWORK"],
  desktop_type: ["NETWORK"],
  desktop_scroll: ["NETWORK"],
  desktop_key: ["NETWORK"],
  desktop_screenshot: ["NETWORK"],
  desktop_wait: ["NETWORK"],
  desktop_stop: ["EXECUTE"],
  computer_screenshot: ["NETWORK"],
  computer_click: ["NETWORK"],
  computer_type: ["NETWORK"],
  computer_scroll: ["NETWORK"],
  computer_key: ["NETWORK"],
  computer_move: ["NETWORK"],
  computer_wait: ["NETWORK"],
  computer_open_app: ["NETWORK", "EXECUTE"],
  "computer.screenshot": ["NETWORK"],
  "computer.click": ["NETWORK"],
  "computer.type": ["NETWORK"],
  "computer.scroll": ["NETWORK"],
  "computer.key": ["NETWORK"],
  "computer.move": ["NETWORK"],
  "computer.wait": ["NETWORK"],
  host_desktop_status: ["SYSTEM"],
  host_desktop_screenshot: ["SYSTEM"],
  host_desktop_click: ["SYSTEM"],
  host_desktop_type: ["SYSTEM"],
  host_desktop_move: ["SYSTEM"],
  host_desktop_scroll: ["SYSTEM"],
  host_desktop_focus: ["SYSTEM"],
  git_status: ["GIT"],
  git_diff: ["GIT"],
  git_log: ["GIT"],
  git_branch: ["GIT"],
  git_checkout: ["GIT", "WRITE"],
  git_commit: ["GIT", "WRITE"],
  generate_image: ["NETWORK"],
  artifact_create: ["WRITE"],
  artifact_write: ["WRITE"],
  artifact_list: ["READ"],
  artifact_read: ["READ"],
  artifact_get: ["READ"],
  artifact_delete: ["DELETE"],
  artifact_get_download: ["READ"],
  artifact_download: ["READ"],
  create_zip: ["WRITE"],
  mcp_list: ["NETWORK"],
  mcp_call: ["NETWORK"],
};

/** What each agent role is allowed to touch. Orchestrator plans; it does not edit. */
const ROLE_CAPABILITIES: Record<AgentRole, Capability[]> = {
  orchestrator: ["READ", "GIT"],
  coder: ["READ", "WRITE", "DELETE", "EXECUTE", "GIT", "NETWORK"],
  tester: ["READ", "EXECUTE", "NETWORK"],
  browser: ["READ", "NETWORK", "EXECUTE"],
  security: ["READ", "GIT"],
  research: ["READ", "NETWORK"],
  // WRITE here covers commit/checkout mutations; the git agent's TOOL list is
  // still restricted to git_* only, so it cannot edit source files.
  git: ["READ", "GIT", "WRITE"],
};

export interface PermissionVerdict {
  allowed: boolean;
  reason?: string;
}

export class PermissionEngine {
  /**
   * When the user flips Autonomous mode on, "ask" tools may run without a
   * per-call approval. It NEVER unlocks capabilities a role does not have,
   * and never unlocks DATABASE / DEPLOYMENT / SYSTEM.
   */
  public autonomous = false;

  /** Runtime-declared capabilities (MCP host registers its tools here). */
  private declared = new Map<string, Capability[]>();

  /** Declares capabilities for a dynamically-registered tool (MCP). */
  declareCapabilities(toolName: string, caps: Capability[]): void {
    this.declared.set(toolName, caps);
  }

  forgetCapabilities(toolName: string): void {
    this.declared.delete(toolName);
  }

  capabilitiesOf(toolName: string): Capability[] {
    return TOOL_CAPABILITIES[toolName] ?? this.declared.get(toolName) ?? ["SYSTEM"];
  }

  checkRole(toolName: string, role: AgentRole | undefined): PermissionVerdict {
    if (!role) return { allowed: true };
    const need = this.capabilitiesOf(toolName);
    const have = ROLE_CAPABILITIES[role] ?? [];
    const missing = need.filter((c) => !have.includes(c));
    if (missing.length > 0) {
      return {
        allowed: false,
        reason: `Role "${role}" lacks ${missing.join("+")} capability required by "${toolName}"`,
      };
    }
    return { allowed: true };
  }
}
