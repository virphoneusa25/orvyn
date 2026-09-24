// One run, one phase. Completion is a decision from evidence, not from model text.

export type RunPhase =
  | "preflight"
  | "introducing"
  | "planning"
  | "acting"
  | "observing"
  | "repairing"
  | "verifying"
  | "waiting_for_user"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";

const ORDER: RunPhase[] = [
  "preflight",
  "introducing",
  "planning",
  "acting",
  "observing",
  "repairing",
  "verifying",
  "waiting_for_user",
  "blocked",
  "completed",
  "failed",
  "cancelled",
];

/** Any phase may move to a terminal or repair phase. Work phases only move forward or into repair. */
export function canEnterPhase(from: RunPhase, to: RunPhase): boolean {
  if (from === to) return true;
  if (from === "completed" || from === "failed" || from === "cancelled") return false;
  if (to === "blocked" || to === "failed" || to === "cancelled" || to === "repairing" || to === "verifying" || to === "acting" || to === "observing") return true;
  return ORDER.indexOf(to) >= ORDER.indexOf(from);
}

export interface CompletionDecisionInput {
  instruction: string;
  events: Array<{ type: string; data?: Record<string, unknown> }>;
}

export type CompletionDecision = "continue" | "completed" | "blocked" | "failed";

function wroteSite(events: CompletionDecisionInput["events"]): boolean {
  return events.some((e) => (e.type === "file.created" || e.type === "file.edit") && /\.(html|css|js|php)$/i.test(String(e.data?.path ?? "")));
}

function reachablePreview(events: CompletionDecisionInput["events"]): boolean {
  return events.some((e) => {
    if (e.type !== "preview.available") return false;
    const url = String(e.data?.url ?? "");
    return /^https?:\/\//i.test(url) && !/localhost|127\.0\.0\.1/i.test(url);
  });
}

function browserVerified(events: CompletionDecisionInput["events"]): boolean {
  return events.some((e) => e.type === "browser.verification_passed" || e.type === "browser.verification.passed" || e.type === "desktop.verification.passed");
}

const WEBSITE = /\b(website|web\s*site|landing\s*page|homepage|home\s*page|joomla)\b/i;
const BUILD = /\b(build|create|make|design|generate)\b/i;

/** Website work is complete only when the files, a non-localhost preview, and a browser check all exist. */
export function decideCompletion(input: CompletionDecisionInput): CompletionDecision {
  if (!(WEBSITE.test(input.instruction) && BUILD.test(input.instruction))) return "completed";
  if (!wroteSite(input.events) || !reachablePreview(input.events) || !browserVerified(input.events)) return "continue";
  return "completed";
}
