// apps/backend/src/agent/AgentTurn.ts
//
// The agent loop as a sequence of turns. One user message drives:
//
//   model turn → tool calls → tool results → next model turn → …
//
// until the run reaches a terminal outcome:
//
//   completed   the model gave a final answer AND the completion evaluator
//               approved it (the only way to complete)
//   blocked     the run needs something from the user (approval, a resource)
//   failed      budget, circuit breaker, provider refusal, evaluator gave up
//   cancelled   the user stopped it
//
// A final answer is never taken at face value: it goes to verification first.
// The evaluator can send the same run back to work (retry) instead of ending.
//
// This module only sequences. What a model call, a tool batch or a
// verification actually does stays in StreamingAgentRuntime, which still
// uses ToolGateway and the ExecutionProvider for every tool. Pattern after
// CoWork-OS's TurnKernel (MIT): a small kernel with policy hooks and honest
// stop reasons. Their runtime is not copied.

import type { ToolCall } from "@orvyn/ai-core";

export type TerminalOutcome = "completed" | "blocked" | "failed" | "cancelled";

/** One model response. */
export interface ModelReply {
  content: string;
  calls: ToolCall[];
  reasoning: string;
  streamedText: boolean;
}

export type ModelTurnResult =
  | { kind: "reply"; reply: ModelReply }
  /** Same step again (e.g. the provider was swapped for one that can do it). */
  | { kind: "retry"; reason: string }
  | { kind: "stop"; outcome: Exclude<TerminalOutcome, "completed">; reason: string };

export type ToolBatchResult =
  | { kind: "ok" | "all_failed" }
  | { kind: "stop"; outcome: Exclude<TerminalOutcome, "completed">; reason: string };

/** What to do with a reply that has no tool calls. */
export type FinalAnswerDecision =
  /** Not a real final answer (only announced work, or never used a tool): work continues. */
  | { kind: "continue"; reason: string }
  | { kind: "verify" };

export type VerificationDecision =
  | { kind: "approved" }
  /** The evaluator found gaps; the prompt was queued and the same run goes on. */
  | { kind: "retry"; reason: string }
  | { kind: "stop"; outcome: Exclude<TerminalOutcome, "completed">; reason: string };

export type TurnKind = "tools" | "retry" | "continue" | "verify_retry" | "final" | "stopped";

export interface AgentTurnRecord {
  turn: number;
  kind: TurnKind;
  /** Tools the model asked for in this turn, in order. */
  tools: string[];
  reason?: string;
  durationMs: number;
}

export interface AgentTurnPolicy {
  maxTurns: number;
  /** Cancellation, budgets, circuit breaker. Return an outcome to stop before the model is called. */
  beforeTurn(turn: number): { outcome: Exclude<TerminalOutcome, "completed">; reason: string } | null;
  requestModelTurn(turn: number): Promise<ModelTurnResult>;
  /** Runs every call through ToolGateway and appends one result per call to the conversation. */
  runTools(turn: number, reply: ModelReply): Promise<ToolBatchResult>;
  onFinalAnswer(turn: number, reply: ModelReply): FinalAnswerDecision;
  /** The completion evaluator. Only "approved" completes the run. */
  verify(turn: number, reply: ModelReply): Promise<VerificationDecision>;
  /** Publishes the approved answer and marks the run completed. */
  complete(turn: number, reply: ModelReply): void;
  /** Called when maxTurns is reached without an outcome. */
  onTurnLimit(turns: number): void;
  onTurn?(record: AgentTurnRecord): void;
}

export interface AgentLoopOutcome {
  outcome: TerminalOutcome;
  reason: string;
  turns: number;
  records: AgentTurnRecord[];
}

export async function runAgentTurns(policy: AgentTurnPolicy): Promise<AgentLoopOutcome> {
  const records: AgentTurnRecord[] = [];
  let turn = 0;
  const record = (r: Omit<AgentTurnRecord, "turn" | "durationMs">, started: number) => {
    const full: AgentTurnRecord = { turn, durationMs: Date.now() - started, ...r };
    records.push(full);
    policy.onTurn?.(full);
  };
  const end = (outcome: TerminalOutcome, reason: string): AgentLoopOutcome => ({ outcome, reason, turns: turn, records });

  while (turn < policy.maxTurns) {
    const pre = policy.beforeTurn(turn + 1);
    if (pre) return end(pre.outcome, pre.reason);
    turn += 1;
    const started = Date.now();

    const model = await policy.requestModelTurn(turn);
    if (model.kind === "stop") {
      record({ kind: "stopped", tools: [], reason: model.reason }, started);
      return end(model.outcome, model.reason);
    }
    if (model.kind === "retry") {
      record({ kind: "retry", tools: [], reason: model.reason }, started);
      continue;
    }

    const { reply } = model;
    const tools = reply.calls.map((c) => c.name);
    if (reply.calls.length > 0) {
      const batch = await policy.runTools(turn, reply);
      if (batch.kind === "stop") {
        record({ kind: "stopped", tools, reason: batch.reason }, started);
        return end(batch.outcome, batch.reason);
      }
      record({ kind: "tools", tools, reason: batch.kind === "all_failed" ? "every tool call failed" : undefined }, started);
      continue;
    }

    const final = policy.onFinalAnswer(turn, reply);
    if (final.kind === "continue") {
      record({ kind: "continue", tools, reason: final.reason }, started);
      continue;
    }

    const verdict = await policy.verify(turn, reply);
    if (verdict.kind === "retry") {
      record({ kind: "verify_retry", tools, reason: verdict.reason }, started);
      continue;
    }
    if (verdict.kind === "stop") {
      record({ kind: "stopped", tools, reason: verdict.reason }, started);
      return end(verdict.outcome, verdict.reason);
    }
    record({ kind: "final", tools }, started);
    policy.complete(turn, reply);
    return end("completed", "completion evaluator approved");
  }

  policy.onTurnLimit(turn);
  return end("failed", `stopped after ${turn} turns without finishing`);
}
