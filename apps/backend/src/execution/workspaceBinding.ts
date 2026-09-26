// Ordinary project tools operate in the run's workspace. SSH and the desktop
// session are different filesystems and are not resolved here.

import { resolveSafePath } from "./pathSafety";
import type { ToolExecutionContext } from "../ai/ToolTypes";

/** Tools whose paths and working directory are the local project workspace. */
export const PROJECT_WORKSPACE_TOOLS = new Set([
  "read_file",
  "write_file",
  "create_file",
  "edit_file",
  "apply_patch",
  "delete_file",
  "move_file",
  "search_code",
  "search_codebase",
  "search_files",
  "list_directory",
  "find_file",
  "related_files",
  "search_tests",
  "get_project_outline",
  "list_symbols",
  "run_tests",
  "run_typecheck",
  "run_linter",
  "get_diagnostics",
  "terminal",
  "run_command",
  "start_process",
]);

/** Argument names that are project paths, not remote commands or host aliases. */
const PATH_FIELDS: Record<string, string[]> = {
  read_file: ["path"],
  write_file: ["path"],
  create_file: ["path"],
  edit_file: ["path"],
  apply_patch: ["path"],
  delete_file: ["path"],
  move_file: ["from", "to"],
  list_directory: ["path"],
  search_code: ["path"],
  search_codebase: ["path"],
  related_files: ["path"],
  search_tests: ["path"],
  get_diagnostics: ["project"],
  run_typecheck: ["project"],
  run_tests: ["filter"],
  git_log: ["path"],
};

export function isProjectWorkspaceTool(name: string): boolean {
  return PROJECT_WORKSPACE_TOOLS.has(name);
}

/** The run workspace when the gateway passed one; otherwise the root the tool was registered with. */
export function workspaceRootFor(registeredRoot: string | undefined, context?: { workspaceRoot?: string }): string {
  const fromRun = String(context?.workspaceRoot ?? "").trim();
  if (fromRun && fromRun !== "." && fromRun !== "./") return fromRun;
  const registered = String(registeredRoot ?? "").trim();
  if (registered && registered !== "." && registered !== "./") return registered;
  throw new Error("No workspace is bound for this run.");
}

export function projectToolContext(
  run: { projectRoot: string; workspaceId?: string | null; runId?: string },
  extra?: Omit<ToolExecutionContext, "workspaceRoot" | "workspaceId">
): ToolExecutionContext {
  return {
    ...extra,
    workspaceRoot: String(run.projectRoot ?? ""),
    ...(run.workspaceId ? { workspaceId: run.workspaceId } : {}),
    ...(run.runId ? { runId: run.runId } : {}),
  };
}

/**
 * Reject a project path that leaves the run workspace.
 * Empty means "the workspace root" and is allowed.
 * A test-name filter with no path characters is left alone.
 */
export function assertInsideWorkspace(workspaceRoot: string, toolName: string, args: Record<string, unknown>): void {
  const root = workspaceRootFor(workspaceRoot);
  for (const field of PATH_FIELDS[toolName] ?? []) {
    const raw = args[field];
    if (raw == null) continue;
    const text = String(raw).trim();
    if (!text) continue;
    if (toolName === "run_tests" && !/[\\/]/.test(text) && !text.includes("..")) continue;
    resolveSafePath(root, text);
  }
}
