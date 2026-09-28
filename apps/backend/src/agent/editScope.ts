// apps/backend/src/agent/editScope.ts
//
// Write-safety scope classification — ONE policy shared by every
// full-content replacement path (write_file, apply_patch, edit_file-as-
// replacement, and the worker's remote writes).
//
// The guard's job is NOT "never replace files". A user who says "redesign
// this site" legitimately authorizes a substantial rewrite. The guard's job
// is to make that distinction explicit and auditable:
//
//   small change            → allow
//   large + read-first + the
//   user asked for a broad
//   redesign                → allow_with_checkpoint (autonomous, checkpointed)
//   large + never read the
//   file                    → read_first (steer: read, then rewrite)
//   large + small-task ask  → replan_as_patch (targeted edits, no user ping)
//
// Authorization comes from THIS policy (user intent + runtime facts), never
// from the model asserting "it's intentional" — reasoning is not approval.

export type TaskScope = "full_redesign" | "targeted" | "unknown";

const BROAD_REDESIGN =
  /\b(redesign|re-?design|rebuild|re-?brand|overhaul|start over|start again from scratch|from scratch|completely (?:new|different|redone)|totally new|new (?:design|look|theme)|don'?t like (?:this|the) (?:site|design|website|page|it)|make it (?:look )?(?:completely )?different|rewrite (?:the )?(?:whole |entire )?(?:site|website|page|design|stylesheet|styles|css)|moderni[sz]e the (?:site|design))\b/i;

const TARGETED_CHANGE =
  /\b(change|make|update|fix|add|remove|rename|increase|decrease|tweak|adjust|set|swap|replace the)\b/i;

/** What the user asked for, from the instruction alone (cheap, deterministic). */
export function classifyTaskScope(instruction: string): TaskScope {
  const text = String(instruction ?? "");
  if (BROAD_REDESIGN.test(text)) return "full_redesign";
  if (TARGETED_CHANGE.test(text)) return "targeted";
  return "unknown";
}

export type WriteGuardDecision = "allow" | "allow_with_checkpoint" | "read_first" | "replan_as_patch";

export interface WriteGuardInput {
  /** Lines of the file being replaced (0 for a new file). */
  oldLines: number;
  newLines: number;
  /** The run read this file before rewriting it. */
  wasRead: boolean;
  taskScope: TaskScope;
  /** Deletion count that counts as a large replacement. */
  threshold?: number;
}

export interface WriteGuardResult {
  decision: WriteGuardDecision;
  deletions: number;
  /** Structured code for the tool result when the write does not proceed. */
  code?: "READ_FIRST_BEFORE_REWRITE" | "DESTRUCTIVE_REWRITE";
}

export function decideWriteGuard(input: WriteGuardInput): WriteGuardResult {
  const threshold = input.threshold ?? Number(process.env.ORVYN_MAX_UNINTENDED_DELETIONS || 300);
  const deletions = input.oldLines - input.newLines;
  const large = input.oldLines >= 80 && deletions >= threshold;
  if (!large) return { decision: "allow", deletions };
  if (!input.wasRead) return { decision: "read_first", deletions, code: "READ_FIRST_BEFORE_REWRITE" };
  if (input.taskScope === "full_redesign") return { decision: "allow_with_checkpoint", deletions };
  return { decision: "replan_as_patch", deletions, code: "DESTRUCTIVE_REWRITE" };
}

/** The structured tool error for a write that must not proceed as-is. */
export function writeGuardError(result: WriteGuardResult, filePath: string): string {
  if (result.code === "READ_FIRST_BEFORE_REWRITE") {
    return `READ_FIRST_BEFORE_REWRITE: replacing ${filePath} would delete ~${result.deletions} lines, and this run has not read the current file. Read it first (read_file), then decide whether a full replacement or a targeted edit is right.`;
  }
  return `DESTRUCTIVE_REWRITE: this would replace ${filePath}, deleting ~${result.deletions} lines for what the request does not authorize as a broad redesign. Use edit_file with exact old_string/new_string for targeted changes. If a full redesign is genuinely wanted, the user must ask for it.`;
}
