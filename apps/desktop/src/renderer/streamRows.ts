// apps/desktop/src/renderer/streamRows.ts
//
// Pure helpers for the chat stream's quiet activity log (no React), so the
// grouping and the Changes totals are unit-testable.

import type { ToolItem } from "./presentationReducer";

interface EventLike { type: string; data?: any }
interface EditPreview { path?: string; additions?: number; deletions?: number }

export type ToolRun = { kind: "toolrun"; key: string; items: ToolItem[] };

/**
 * Consecutive tool steps of the same kind (two commands in a row, three
 * reads) become one quiet row, "Terminal · 2 commands", like a coding
 * assistant's log. Verifier steps and file writes keep their own rows.
 */
export function groupToolRuns<T extends { kind: string; key: string }>(items: T[]): Array<T | ToolRun> {
  const out: Array<T | ToolRun> = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "toolrun", key: `run-${run[0]!.key}`, items: run });
    else if (run.length === 1) out.push(run[0] as unknown as T);
    run = [];
  };
  for (const item of items) {
    const tool = item.kind === "tool" ? (item as unknown as ToolItem) : null;
    const groupable = tool && ["terminal", "read", "search", "browser", "web", "git", "test"].includes(tool.op) && tool.toolName !== "generate_image";
    if (groupable && run.length && (run[0]!.op !== tool!.op || Boolean(run[0]!.verifier) !== Boolean(tool!.verifier))) flush();
    if (groupable) { run.push(tool!); continue; }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/** Changed-lines totals for this run's file edits (the "Changes +N −M" pill). */
export function changeTotals(events: EventLike[]): { files: number; additions: number; deletions: number } {
  const edits = new Map<string, { additions: number; deletions: number }>();
  for (const e of events) {
    if (e.type !== "file.edit" && e.type !== "file.created") continue;
    const p = e.data?.preview as EditPreview | undefined;
    const key = String(p?.path || e.data?.path || "");
    if (!key) continue;
    const prev = edits.get(key) ?? { additions: 0, deletions: 0 };
    const add = Number(p?.additions ?? e.data?.additions ?? 0) || 0;
    const del = Number(p?.deletions ?? e.data?.deletions ?? 0) || 0;
    edits.set(key, { additions: prev.additions + add, deletions: prev.deletions + del });
  }
  let additions = 0;
  let deletions = 0;
  for (const v of edits.values()) { additions += v.additions; deletions += v.deletions; }
  return { files: edits.size, additions, deletions };
}

