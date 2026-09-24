// apps/backend/src/agent/continuation.ts
//
// Phase 1 (core agent loop): a model reply WITHOUT a tool call is only a final
// answer when it actually concludes the task. Real models regularly end a turn
// by announcing the next step in prose ("Next, I'll read it back…") and stop.
// Accepting that as completion is exactly the "ORION stops after one tool"
// failure. This module decides when such a reply is an unfinished hand-off so
// the runtime can send the SAME agent back to work instead of completing.

/** Sentences that promise work the model has not done yet. */
const PENDING =
  /(?:^|[\s,;:—-])(?:next|now|then|first|after that|afterwards)?[,\s]*(?:i['’]ll|i will|i am going to|i['’]m going to|let me|i need to|i should|i['’]ll now|i will now|going to)\s+(?:now\s+)?(?:read|open|run|check|verify|create|write|edit|update|fix|test|build|start|install|look|inspect|search|list|execute|call|use|try|confirm|continue|proceed|deploy|restart|fetch|navigate|take|capture|generate|add|apply|re-?run|re-?check|compare|review|make|save|delete|move|copy|launch|connect)\b/i;

/** Wording that hands control back to the user — a legitimate stop. */
const ASKS_USER =
  /\?\s*$|\b(let me know|would you like|do you want|should i|shall i|if you(?:['’]d)? like|please (?:confirm|provide|tell|share|connect|choose|approve)|i need (?:you|your)|waiting for you)\b/i;

/** Wording that reports an outcome — a legitimate stop. */
const CONCLUDES =
  /\b(done|completed?|finished|all set|here(?:['’]s| is) (?:the|what)|in summary|to summarize|the (?:result|output|file) (?:is|shows|contains)|it contains|(?:was|were|has been|have been) (?:created|written|updated|fixed|verified|confirmed)|(?:passed|succeeded|failed|could not|couldn['’]t|unable to|blocked))\b/i;

function lastSentence(text: string): string {
  const cleaned = text.replace(/```[\s\S]*?```/g, " ").trim();
  const parts = cleaned.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * True when a tool-less reply ends by promising further work the agent itself
 * should do — i.e. the run is NOT finished. Conservative: questions to the user
 * and outcome reports always count as a real stop.
 */
export function announcesPendingWork(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  const tail = lastSentence(t);
  if (!tail || ASKS_USER.test(tail)) return false;
  if (!PENDING.test(tail)) return false;
  // "Done — next I'll …" still promises work; only a tail that reports the
  // outcome WITHOUT a promise counts as concluding.
  return !(CONCLUDES.test(tail) && !PENDING.test(tail));
}

/** How many times one run may be sent back after announcing work. */
export const MAX_CONTINUATION_NUDGES = 3;

export const CONTINUATION_PROMPT =
  "Continue now: perform the step you just described by calling the appropriate tool. Do not describe it again. Reply without a tool call only when the whole request is finished, and then state the verified result.";
