// apps/backend/src/models/stepRouting.ts
//
// Per-step model switching inside one run. When the Code or Server agent is
// only looking around (reading files, searching, read-only commands like
// `systemctl status` or `journalctl`), the next look-around step is handed to
// a cheaper helper model. The helper may only gather: if it wants to change
// anything, or thinks it is done, its step is discarded and the main model
// takes the turn — edits, repairs and final answers always come from the
// run's main model.

import { classifyCommand, commandOf } from "../gateway/commandRisk";
import { TIERS, weightFor, type RouteProfile, type RouteStep, type Tier } from "./routingPolicy";

export const READ_ONLY_TOOLS = new Set([
  "read_file", "list_directory", "list_files", "search_files", "search_code", "search_codebase", "find_symbol", "find_file",
  "related_files", "search_tests", "get_project_outline", "list_symbols", "git_status", "git_diff", "git_log", "git_branch",
  "read_process_logs", "process_status", "list_processes", "read_document", "web_search", "fetch_url",
]);

/** A call that only looks: a read tool, or a read-only command (terminal / SSH). */
export function isReadOnlyCall(name: string, args?: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true;
  const cmd = commandOf(name, args);
  return cmd !== null && classifyCommand(cmd) === "read";
}

/** Cheaper models that may take look-around steps, per profile. */
export const HELPER_TIERS: Record<RouteProfile, Tier[]> = {
  code: ["code-helper", "auto"],
  server: ["auto", "utility"],
  auto: [],
  deep: [],
};

/** How many look-only batches in a row before a helper takes the next one. */
export const HELPER_AFTER_READ_STEPS = 2;
/** After this many rejected helper steps in a run, stop trying. */
export const MAX_HELPER_REJECTS = 2;

export function helperFor(route: RouteStep | undefined, currentModelId: string, availableIds: string[]): string | null {
  if (!route) return null;
  const available = new Set(availableIds);
  const current = weightFor(currentModelId);
  for (const tier of HELPER_TIERS[route.profile]) {
    for (const id of TIERS[tier].candidates) {
      if (available.has(id) && id !== currentModelId && weightFor(id) < current) return id;
    }
  }
  return null;
}

export function shouldUseHelper(input: { route?: RouteStep; readOnlyStreak: number; helperRejects: number; currentModelId: string; pinned: boolean }): boolean {
  if (input.pinned || !input.route) return false;
  if (input.route.profile !== "code" && input.route.profile !== "server") return false;
  if (weightFor(input.currentModelId) < 4) return false;
  return input.readOnlyStreak >= HELPER_AFTER_READ_STEPS && input.helperRejects < MAX_HELPER_REJECTS;
}

export const HELPER_NOTE =
  "[ORVYN step note] This is an information-gathering step. Continue gathering only what the task still needs: read files, search, or run read-only commands. Do not change anything (no writes, edits, installs, restarts) and do not give a final answer. If nothing more needs to be gathered, reply without calling a tool.";

/** The helper's step is kept only if it gathered (at least one call) and every call only looks. */
export function acceptHelperStep(calls: { name: string; arguments?: Record<string, unknown> }[]): boolean {
  return calls.length > 0 && calls.every((c) => isReadOnlyCall(c.name, c.arguments));
}
