// apps/backend/src/agent/capabilityManifest.ts
//
// What ORION can actually do in this run, from the real tool registry and its
// permissions — never from tool names the model guesses.
//
// Tool classes:
//   core        ORVYN ships it: files, shell, git, browser, workspace. Never a
//               Marketplace item; only permissions can take it away.
//   mcp         an installed MCP server's tool (mcp.<server>.<tool>).
//   plugin      a skill/plugin-provided tool.
//   integration a first-party connector (GitHub, email, …) that needs sign-in.
//
// The install card ("Find a tool") is shown only when the capability is not
// native, not already provided by an installed MCP tool, genuinely needs an
// outside service, and no native fallback exists (resolveCapabilityNeed).

import { builtInToolsFor, needsExternalTool } from "./capabilityGap";

export type ToolClass = "core" | "mcp" | "plugin" | "integration";

/** ORVYN's own tools. The Marketplace never provides these. */
export const CORE_TOOLS: Record<string, "read" | "write" | "shell" | "git" | "browser" | "workspace"> = {
  read_file: "read", list_directory: "read", list_files: "read", search_code: "read", search_files: "read", search_codebase: "read",
  find_symbol: "read", find_file: "read", get_project_outline: "read", related_files: "read", read_document: "read",
  write_file: "write", edit_file: "write", apply_edit: "write", delete_file: "write", move_file: "write", rename_file: "write",
  terminal: "shell", run_command: "shell", run_tests: "shell", run_typecheck: "shell", run_linter: "shell",
  start_process: "shell", stop_process: "shell", read_process_logs: "shell", list_processes: "shell",
  git_status: "git", git_diff: "git", git_log: "git", git_branch: "git", git_checkout: "git", git_commit: "git",
  browser_open: "browser", browser_navigate: "browser", browser_screenshot: "browser", browser_console_errors: "browser",
  browser_click: "browser", browser_type: "browser", browser_scroll: "browser", browser_set_viewport: "browser", browser_evidence: "browser",
  resolve_workspace: "workspace",
};

const INTEGRATIONS = /^(github_|gmail_|email_|send_email|slack_|calendar_|google_)/;

export function classifyTool(name: string): ToolClass {
  if (CORE_TOOLS[name]) return "core";
  if (/^mcp[._]/.test(name)) return "mcp";
  if (INTEGRATIONS.test(name)) return "integration";
  if (/^(skill|plugin)[._]/.test(name)) return "plugin";
  return "core";
}

export interface CapabilityManifest {
  workspace: { root: string; readable: boolean; writable: boolean; shell: boolean; git: boolean; location: string };
  browser: { preview: boolean; screenshot: boolean; console: boolean; network: boolean };
  mcp: string[];
  integrations: string[];
}

export interface ToolLike { name: string }
type Permission = "allowed" | "ask" | "denied" | string;

/** The manifest from the registry this run really has (after remote tools were mounted). */
export function buildCapabilityManifest(
  tools: ToolLike[],
  permission: (name: string) => Permission,
  opts: { projectRoot?: string; location?: string; previewAvailable?: boolean } = {}
): CapabilityManifest {
  const usable = (name: string) => tools.some((t) => t.name === name) && permission(name) !== "denied";
  const any = (kind: string) => Object.entries(CORE_TOOLS).some(([n, k]) => k === kind && usable(n));
  return {
    workspace: {
      root: opts.projectRoot ?? "",
      readable: any("read"),
      writable: usable("write_file") || usable("edit_file"),
      shell: any("shell"),
      git: any("git") || any("shell"),
      location: opts.location ?? "local",
    },
    browser: {
      preview: opts.previewAvailable !== false,
      screenshot: usable("browser_screenshot"),
      console: usable("browser_console_errors") || usable("browser_evidence"),
      network: usable("browser_evidence") || usable("browser_open"),
    },
    mcp: tools.filter((t) => classifyTool(t.name) === "mcp").map((t) => t.name).slice(0, 40),
    integrations: tools.filter((t) => classifyTool(t.name) === "integration").map((t) => t.name).slice(0, 20),
  };
}

/** The factual state the model plans against. */
export function manifestPrompt(m: CapabilityManifest): string {
  const yes = (b: boolean) => (b ? "yes" : "NO");
  return [
    "CAPABILITIES (facts from ORVYN, not guesses):",
    `- Project workspace: read files ${yes(m.workspace.readable)}, create/edit/delete files ${yes(m.workspace.writable)}, run shell commands ${yes(m.workspace.shell)}, git ${yes(m.workspace.git)}.`,
    `- Browser: live preview ${yes(m.browser.preview)}, screenshots ${yes(m.browser.screenshot)}, console ${yes(m.browser.console)}.`,
    `- Installed MCP tools: ${m.mcp.length ? m.mcp.join(", ") : "none"}.`,
    "Editing, creating or deleting project files, running commands, git and checking the preview are ORVYN core tools you already have. Never ask for an MCP tool, a plugin or an install for them.",
    "search_capabilities is only for outside services this run has no tool for (email, Slack, a CRM, a database server, a calendar…).",
    m.workspace.writable ? "" : "Writing to this workspace is switched off by its permissions. If the task needs changes, say: \"ORVYN needs permission to modify this workspace.\" — not that a tool is missing.",
  ].filter(Boolean).join("\n");
}

export type CapabilityNeed =
  | { kind: "native"; tools: string[] }
  | { kind: "permission"; message: string }
  | { kind: "installed"; tools: string[] }
  | { kind: "mcp" };

/**
 * Decides what a capability request really is. Only the last case shows the
 * Marketplace card.
 */
export function resolveCapabilityNeed(
  query: string,
  m: CapabilityManifest,
  known: (name: string) => boolean,
  evidence: { filesChanged?: number } = {}
): CapabilityNeed {
  const external = needsExternalTool(query);
  if (!external) {
    // Project work. The run already changed files, or has write tools: native.
    const tools = builtInToolsFor(query, known);
    const wantsWrite = tools.some((t) => CORE_TOOLS[t] === "write") || /\b(edit|write|create|add|change|update|fix|remove|delete|replace|build|make)\b/i.test(query);
    if (wantsWrite && !m.workspace.writable && !(evidence.filesChanged && evidence.filesChanged > 0)) {
      return { kind: "permission", message: "ORVYN needs permission to modify this workspace." };
    }
    return { kind: "native", tools: tools.length ? tools : Object.keys(CORE_TOOLS).filter(known).slice(0, 8) };
  }
  const words = query.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
  const installed = m.mcp.filter((name) => words.some((w) => name.toLowerCase().includes(w)));
  if (installed.length) return { kind: "installed", tools: installed };
  return { kind: "mcp" };
}
