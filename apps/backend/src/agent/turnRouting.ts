// One owner per user turn: an answer-only prompt ("Hi", "What can you do?",
// "How do I configure nginx?") is a chat turn — never a run. Creating a run
// for it is what produced "chat reply + unrelated run.blocked" doubles.
// The desktop classifier makes this call before submitting; this gate is the
// same decision server-side for every caller of the run endpoints.

import { inferTaskIntent } from "./taskIntent";

export type TurnRoute = "chat" | "run";

export function routeTurn(instruction: string, composerMode?: string): TurnRoute {
  return inferTaskIntent(instruction, composerMode).executionComplexity === "answer" ? "chat" : "run";
}
