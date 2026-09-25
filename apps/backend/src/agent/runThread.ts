// apps/backend/src/agent/runThread.ts
//
// A WorkSession's runs as one conversation: every follow-up message starts a
// new run in the same session. The desktop shows all of them as one stream,
// and the model gets all of them as history — not only the last run.

import type { AgentEvent, Run, RunStore } from "./events";

export interface ThreadRunSummary {
  runId: string;
  status: string;
  createdAt: number;
  instruction: string;
}

export function instructionOf(run: Pick<Run, "events">): string {
  return String(run.events.find((e) => e.type === "run.started")?.data?.instruction ?? "");
}

/** The runs of a session that the run store still holds, oldest first. */
export function sessionRuns(store: RunStore, runIds: string[]): Run[] {
  return runIds.map((id) => store.get(id)).filter((r): r is Run => Boolean(r)).sort((a, b) => a.createdAt - b.createdAt);
}

export function summarizeRuns(store: RunStore, runIds: string[]): ThreadRunSummary[] {
  // A run the store no longer holds is still part of the session; it is listed without detail.
  return runIds.map((runId) => {
    const r = store.get(runId);
    return r
      ? { runId, status: r.status, createdAt: r.createdAt, instruction: instructionOf(r) }
      : { runId, status: "unavailable", createdAt: 0, instruction: "" };
  });
}

/** What ORION finally told the user in a run (not its mid-run narration). */
export function finalAnswerOf(events: AgentEvent[]): string {
  const grounded = [...events].reverse().find((e) => e.type === "message.grounded");
  if (grounded) return String(grounded.data.content ?? "");
  let lastTool = -1;
  events.forEach((e, i) => { if (e.type === "tool.completed" || e.type === "tool.failed") lastTool = i; });
  const after = events.slice(lastTool + 1).filter((e) => e.type === "message.delta").map((e) => String(e.data.content ?? "")).join("");
  if (after.trim()) return after.trim();
  return events.filter((e) => e.type === "message.delta").map((e) => String(e.data.content ?? "")).join("").slice(-4000).trim();
}

/** One line per tool result, from the envelopes: "Wrote hello.txt · 16 bytes". */
export function workDoneIn(events: AgentEvent[]): string[] {
  return events
    .filter((e) => (e.type === "tool.completed" || e.type === "tool.failed") && !e.data.verifier)
    .map((e) => {
      const env = e.data.envelope as { userSummary?: string } | undefined;
      return env?.userSummary ?? `${String(e.data.tool ?? "tool")} ${e.type === "tool.failed" ? "failed" : "done"}`;
    });
}

/**
 * Model history for a follow-up: the session's earlier runs, oldest first, as
 * the user's message and ORION's answer (with what it did). The newest runs
 * win when the budget is tight.
 */
export function threadHistory(store: RunStore, runIds: string[], budgetChars = 24_000): { role: "user" | "assistant"; content: string }[] {
  const runs = sessionRuns(store, runIds);
  const turns: { role: "user" | "assistant"; content: string }[][] = [];
  let used = 0;
  for (const run of [...runs].reverse()) {
    const instruction = instructionOf(run).slice(0, 4000);
    const work = workDoneIn(run.events);
    const answer = finalAnswerOf(run.events).slice(0, 8000);
    const status = run.status === "completed" ? "" : `\n[This run ended: ${run.status}]`;
    const assistant = [
      work.length ? `Work done:\n${work.slice(-20).map((w) => `- ${w}`).join("\n")}` : "",
      answer,
    ].filter(Boolean).join("\n\n") + status;
    const size = instruction.length + assistant.length;
    if (turns.length > 0 && used + size > budgetChars) break;
    used += size;
    turns.unshift([{ role: "user", content: instruction }, { role: "assistant", content: assistant || "(no answer)" }]);
  }
  return turns.flat();
}
