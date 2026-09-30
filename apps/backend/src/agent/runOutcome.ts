// apps/backend/src/agent/runOutcome.ts
//
// How a finished run really went, from its own events — never from what the
// model said. "complete" only when every required check that ran passed and
// nothing was left waiting on the user; otherwise "partial" with the reasons.

type Ev = { type: string; data?: Record<string, any> };

export interface RunOutcome { outcome: "complete" | "partial"; reasons: string[] }

export function runOutcome(events: Ev[]): RunOutcome {
  const reasons: string[] = [];
  const lastOf = (...types: string[]) => [...events].reverse().find((e) => types.includes(e.type));
  const preview = lastOf("preview.verified", "preview.failed");
  if (preview?.type === "preview.failed") reasons.push(`Preview: ${(preview.data?.issues as string[] | undefined)?.slice(0, 3).join("; ") || "the page did not load as the styled site"}`);
  const verification = lastOf("verification.completed");
  if (verification && verification.data?.verdict === "FAIL") reasons.push("Verification failed.");
  // A tool the run asked for and never got (an install card left open).
  const needed = events.filter((e) => e.type === "capability.required").map((e) => String(e.data?.query ?? ""));
  const installed = events.some((e) => e.type === "capability.installed");
  if (needed.length && !installed) reasons.push(`Needs a tool that is not installed: ${needed[0]}.`);
  if (events.some((e) => e.type === "permission.required")) reasons.push("ORVYN needs permission to modify this workspace.");
  if (events.some((e) => e.type === "run.budget_reached")) reasons.push("Stopped at this run's execution budget before everything was verified. Say \"continue\" to pick up where it left off.");
  return { outcome: reasons.length ? "partial" : "complete", reasons };
}
