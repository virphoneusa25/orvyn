// apps/backend/src/agent/editPreview.ts
//
// Computes what a file-mutating tool WOULD do, before it does it.
//
// The point is the approval gate: asking "allow write_file?" while showing the
// raw JSON arguments forces the user to approve a change they cannot see. A
// diff is the only form in which a proposed edit is actually reviewable, which
// is the whole premise of Cursor-style editing.
//
// Every function here is read-only and best-effort — a preview that fails must
// never block the edit it was describing.

import { promises as fs } from "fs";
import { diffLines, diffStats, DiffLine } from "../composer/diff";
import { resolveSafe } from "../ai/tools/fileTools";

/** Diffing is O(n*m); past this the preview is summarised instead of computed. */
const MAX_DIFF_CHARS = 200_000;
/** Cap on diff lines sent to the UI — a 5k-line diff helps nobody render. */
const MAX_DIFF_LINES = 400;

export interface EditPreview {
  path: string;
  kind: "create" | "modify" | "delete" | "move";
  additions: number;
  deletions: number;
  /** Trimmed unified-style diff for display. Absent for oversized files. */
  diff?: DiffLine[];
  truncated?: boolean;
  note?: string;
}

/**
 * Keeps the diff renderable by collapsing long runs of unchanged lines, the
 * same way `git diff` does with hunk context.
 */
function trimDiff(lines: DiffLine[]): { lines: DiffLine[]; truncated: boolean } {
  if (lines.length <= MAX_DIFF_LINES) return { lines, truncated: false };

  const keep = new Set<number>();
  const CONTEXT = 3;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type === "context") continue;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(lines.length - 1, i + CONTEXT); j++) {
      keep.add(j);
    }
  }

  const out: DiffLine[] = [];
  let lastKept = -1;
  for (let i = 0; i < lines.length && out.length < MAX_DIFF_LINES; i++) {
    if (!keep.has(i)) continue;
    if (lastKept !== -1 && i > lastKept + 1) {
      out.push({ type: "context", content: `… ${i - lastKept - 1} unchanged lines …` });
    }
    out.push(lines[i]);
    lastKept = i;
  }
  return { lines: out, truncated: out.length < keep.size };
}

async function readIfExists(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf-8");
  } catch {
    return null;
  }
}

function build(path: string, before: string | null, after: string): EditPreview {
  const kind = before === null ? "create" : "modify";
  const original = before ?? "";

  if (original.length + after.length > MAX_DIFF_CHARS) {
    const beforeLines = original ? original.split("\n").length : 0;
    const afterLines = after.split("\n").length;
    return {
      path,
      kind,
      additions: Math.max(0, afterLines - beforeLines),
      deletions: Math.max(0, beforeLines - afterLines),
      note: "File too large to diff inline; line counts are approximate.",
    };
  }

  const all = diffLines(original, after);
  const { additions, deletions } = diffStats(all);
  const { lines, truncated } = trimDiff(all);
  return { path, kind, additions, deletions, diff: lines, truncated };
}

/**
 * Best-effort preview of a pending tool call. Returns undefined for tools that
 * do not touch files, and never throws — a preview failure must not stop the
 * agent from doing the work.
 */
export async function previewToolEdit(
  projectRoot: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<EditPreview | undefined> {
  try {
    switch (toolName) {
      case "write_file": {
        const rel = String(args.path ?? "");
        if (!rel) return undefined;
        const target = resolveSafe(projectRoot, rel);
        return build(rel, await readIfExists(target), String(args.content ?? ""));
      }

      case "edit_file": {
        const rel = String(args.path ?? "");
        const oldString = String(args.old_string ?? "");
        if (!rel || !oldString) return undefined;
        const target = resolveSafe(projectRoot, rel);
        const original = await readIfExists(target);
        // Let the tool itself report a missing file or a non-matching anchor;
        // the preview just declines to guess.
        if (original === null || !original.includes(oldString)) return undefined;
        const newString = String(args.new_string ?? "");
        const after =
          args.replace_all === true
            ? original.split(oldString).join(newString)
            : original.replace(oldString, newString);
        return build(rel, original, after);
      }

      case "delete_file": {
        const rel = String(args.path ?? "");
        if (!rel) return undefined;
        const original = await readIfExists(resolveSafe(projectRoot, rel));
        return {
          path: rel,
          kind: "delete",
          additions: 0,
          deletions: original ? original.split("\n").length : 0,
        };
      }

      case "move_file": {
        const from = String(args.from ?? "");
        const to = String(args.to ?? "");
        if (!from || !to) return undefined;
        return { path: `${from} → ${to}`, kind: "move", additions: 0, deletions: 0 };
      }

      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** True for tools whose approval card should render a diff. */
export function isFileMutatingTool(name: string): boolean {
  return name === "write_file" || name === "edit_file" || name === "delete_file" || name === "move_file";
}
