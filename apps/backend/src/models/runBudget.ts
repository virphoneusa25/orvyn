// Run-budget helpers: when a long run should be told to wrap up, and which
// model to route to when the user attached an image.

import type { AIModelProvider } from "@orvyn/ai-core";

/**
 * The hard cap kills a run mid-verification ("execution limit reached").
 * A soft warning first — at this share of the budget — lets the model
 * finish the change in progress, verify quickly, and complete truthfully.
 */
export const BUDGET_WARN_SHARE = 0.75;

export function budgetWarnLevel(spent: number, cap: number, alreadyWarned: boolean): null | "warn" {
  if (alreadyWarned || cap <= 0) return null;
  return spent / cap >= BUDGET_WARN_SHARE ? "warn" : null;
}

/** Wrap-up note the model receives once the run enters the last budget quartile. */
export function budgetWrapNote(usedPct: number): string {
  return `[Runtime note] This run has used ${usedPct}% of its execution budget. Wrap up now: finish the change in progress, verify with the fastest meaningful check (browser_* or one terminal command — not a long suite), and deliver a final summary of what is done and what remains. Do not start new large work.`;
}

/** The last turn once the budget is reached: no tools, an honest summary. */
export function budgetFinalNote(): string {
  return `[Runtime note] This run has reached its execution budget. Do NOT call any more tools. Reply now with the final summary: what you changed (files), what you verified and how, and exactly what remains unfinished or unverified. The user can say "continue" to resume from here.`;
}

/**
 * A model without vision cannot see an attached image, so "use the logo
 * attached" is a note about a file it can never look at. Pick the first
 * registered platform (never a customer's own) agent model with tools and
 * vision.
 */
export function pickVisionFallback(
  providers: AIModelProvider[],
  currentId: string,
  isUserModel: (id: string) => boolean
): AIModelProvider | null {
  return (
    providers.find(
      (p) =>
        p.config.id !== currentId &&
        !isUserModel(p.config.id) &&
        p.config.capabilities.agent &&
        p.supportsTools() &&
        p.supportsVision()
    ) ?? null
  );
}
