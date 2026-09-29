// §31 — a machine-readable verification scorecard on every
// verification.completed event: check name → pass/fail/skip/unverified,
// plus whether the checks a task REQUIRES all passed.

import type { VerificationCheck } from "./VerificationRuntime";

export type ScoreStatus = "pass" | "fail" | "skip" | "unverified";
export type Scorecard = Record<string, ScoreStatus>;

export function scorecardFromChecks(checks: VerificationCheck[]): Scorecard {
  const out: Scorecard = {};
  for (const c of checks) {
    // Names may repeat across attempts; the latest one wins.
    out[c.name] = c.status;
  }
  return out;
}

/**
 * Completion depends on required checks: every named check must be "pass".
 * "skip" is honest for a check this task did not need ONLY when it is not
 * required; a required check that skipped or went unverified fails this.
 */
export function requiredChecksPass(scorecard: Scorecard, required: string[]): boolean {
  return required.every((name) => scorecard[name] === "pass");
}

/** The checks a website task must not skip, per the task-aware policy. */
export function requiredChecksForTask(website: boolean): string[] {
  return website ? ["page_load", "css_assets", "console_errors"] : [];
}
