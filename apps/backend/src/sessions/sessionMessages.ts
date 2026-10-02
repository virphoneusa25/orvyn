// apps/backend/src/sessions/sessionMessages.ts
//
// Durable messages for a WorkSession, written by the backend as they happen:
//   * a run's instruction is stored when the run starts,
//   * ORION's final answer is stored when the run ends,
//   * a chat turn (WS /ws/chat) is stored when it arrives, and its reply as it
//     streams (every couple of seconds) and when it is done.
// Nothing waits for the desktop to save a file: closing or crashing the app
// right after sending loses nothing.

import type { Run, RunStore } from "../agent/events";
import { finalAnswerOf } from "../agent/runThread";
import type { SessionMessage, WorkSessionStore } from "./WorkSessionStore";
import type { TurnDecision } from "@orvyn/ai-core";

/** Stable ids, so a retry or a second writer updates instead of duplicating. */
export const runAnswerMessageId = (runId: string) => `msg_answer_${runId}`;

export function recordRunInstruction(
  sessions: WorkSessionStore,
  sessionId: string,
  runId: string,
  instruction: string,
  opts: { messageId?: string; mode?: string; turnDecision?: TurnDecision } = {},
): SessionMessage | undefined {
  if (!instruction.trim()) return undefined;
  return sessions.appendMessage(sessionId, {
    messageId: opts.messageId,
    role: "user",
    content: instruction,
    runId,
    mode: opts.mode ?? "agent",
    ...(opts.turnDecision ? { meta: { turnDecision: opts.turnDecision } } : {}),
  });
}

/**
 * Whether the run's current state justifies persisting a final assistant
 * message. `blocked` is settled but NOT necessarily answer-final: a mid-run
 * block pauses for a resource and the run resumes — only a settlement-emitted
 * (`terminal: true`) block ends the capture.
 */
function shouldPersistFinalAnswer(run: Run): boolean {
  if (run.status === "completed" || run.status === "partial" || run.status === "error" || run.status === "cancelled") return true;
  if (run.status === "blocked") {
    return run.events.some((e) => e.type === "run.blocked" && e.data.terminal === true);
  }
  return false;
}

/** Stores ORION's final answer once the run reaches a terminal state. */
export function recordRunAnswer(sessions: WorkSessionStore, store: RunStore, sessionId: string, runId: string): void {
  const save = () => {
    const run = store.get(runId);
    if (!run) return;
    // A blocked run's fallback carries the actual reason (missing resource,
    // approval, policy) — "interrupted" is only one of the possible causes.
    const blockedReason = run.status === "blocked"
      ? [...run.events].reverse().find((e) => e.type === "run.blocked" && typeof e.data.message === "string")?.data.message as string | undefined
      : undefined;
    const answer = finalAnswerOf(run.events)
      || blockedReason
      || (run.status === "cancelled" ? "Stopped."
        : run.status === "error" ? "The run ended with an error."
        : run.status === "blocked" ? "The run is blocked — it needs input or a required resource before it can continue."
        : run.status === "partial" ? "The run finished with remaining gaps."
        : "");
    if (!answer) return;
    sessions.appendMessage(sessionId, { messageId: runAnswerMessageId(runId), role: "assistant", content: answer, runId, mode: "agent" });
  };
  const run = store.get(runId);
  if (!run) return;
  if (shouldPersistFinalAnswer(run)) { save(); return; }
  const unsubscribe = store.subscribe(runId, (e) => {
    // A mid-run block pauses for a resource — the answer isn't final yet.
    // Only a settlement-emitted (terminal) block ends the capture.
    const terminalBlock = e.type === "run.blocked" && e.data.terminal === true;
    if (e.type === "run.completed" || e.type === "run.partial" || e.type === "run.error" || e.type === "run.cancelled" || terminalBlock) {
      unsubscribe();
      // After the event is in the log, so the answer includes the last words.
      setImmediate(() => { try { save(); } catch { /* storage must never break a run */ } });
    }
  });
}

/**
 * One chat turn over the WebSocket. The user's message is stored now; the
 * reply is stored as "streaming" and saved every SAVE_EVERY_MS while tokens
 * arrive, then marked complete.
 */
export class ChatTurnRecorder {
  private text = "";
  private lastSave = 0;
  private done = false;
  private replyId: string | null = null;
  static SAVE_EVERY_MS = 2000;

  constructor(
    private readonly sessions: WorkSessionStore,
    private readonly sessionId: string,
    input: { userMessage: string; userMessageId?: string; assistantMessageId?: string; userCreatedAt?: number; mode?: string; attachments?: unknown[]; turnDecision?: TurnDecision },
  ) {
    const mode = input.mode ?? "chat";
    sessions.appendMessage(sessionId, {
      messageId: input.userMessageId, role: "user", content: input.userMessage, mode, createdAt: input.userCreatedAt,
      // The files the user attached (their stored artifact ids), so reopening the chat shows them.
      ...(input.attachments?.length || input.turnDecision ? { meta: { ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.turnDecision ? { turnDecision: input.turnDecision } : {}) } } : {}),
    });
    const reply = sessions.appendMessage(sessionId, { messageId: input.assistantMessageId, role: "assistant", content: "", mode, status: "streaming" });
    this.replyId = reply?.messageId ?? null;
  }

  private activities: unknown[] = [];

  /** A web search or page read during the reply (kept with the reply, for restore). */
  activity(a: { id: string }): void {
    if (this.done || !this.replyId) return;
    const i = this.activities.findIndex((x) => (x as { id: string }).id === a.id);
    if (i >= 0) this.activities[i] = a; else this.activities.push(a);
    this.sessions.updateMessage(this.replyId, { meta: { activity: this.activities } });
  }

  /** Files the reply produced (e.g. a generated image), kept with the reply. */
  artifacts(list: unknown[]): void {
    if (!this.replyId || !list.length) return;
    this.sessions.updateMessage(this.replyId, { meta: { artifacts: list } });
  }

  /** The reply so far was withdrawn (ORION researches first). The persisted
   *  copy is cleared too — an autosave may already have written the retracted
   *  text, and a crash must not resurrect it. */
  retract(): void {
    if (this.done) return;
    this.text = "";
    if (this.replyId) this.sessions.updateMessage(this.replyId, { content: "" });
  }

  delta(chunk: string): void {
    if (this.done || !chunk) return;
    this.text += chunk;
    if (this.replyId && Date.now() - this.lastSave > ChatTurnRecorder.SAVE_EVERY_MS) {
      this.lastSave = Date.now();
      this.sessions.updateMessage(this.replyId, { content: this.text });
    }
  }

  finish(error?: string): void {
    if (this.done) return;
    this.done = true;
    if (!this.replyId) return;
    const content = error ? `${this.text}${this.text ? "\n\n" : ""}${error}` : this.text;
    this.sessions.updateMessage(this.replyId, { content, status: "complete" });
  }
}
