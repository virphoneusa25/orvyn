// apps/backend/src/sessions/sessionMessages.ts
//
// Durable messages for a WorkSession, written by the backend as they happen:
//   * a run's instruction is stored when the run starts,
//   * ORION's final answer is stored when the run ends,
//   * a chat turn (WS /ws/chat) is stored when it arrives, and its reply as it
//     streams (every couple of seconds) and when it is done.
// Nothing waits for the desktop to save a file: closing or crashing the app
// right after sending loses nothing.

import type { RunStore } from "../agent/events";
import { isTerminal } from "../agent/events";
import { finalAnswerOf } from "../agent/runThread";
import type { SessionMessage, WorkSessionStore } from "./WorkSessionStore";

/** Stable ids, so a retry or a second writer updates instead of duplicating. */
export const runAnswerMessageId = (runId: string) => `msg_answer_${runId}`;

export function recordRunInstruction(
  sessions: WorkSessionStore,
  sessionId: string,
  runId: string,
  instruction: string,
  opts: { messageId?: string; mode?: string } = {},
): SessionMessage | undefined {
  if (!instruction.trim()) return undefined;
  return sessions.appendMessage(sessionId, {
    messageId: opts.messageId,
    role: "user",
    content: instruction,
    runId,
    mode: opts.mode ?? "agent",
  });
}

/** Stores ORION's final answer once the run reaches a terminal state. */
export function recordRunAnswer(sessions: WorkSessionStore, store: RunStore, sessionId: string, runId: string): void {
  const save = () => {
    const run = store.get(runId);
    if (!run) return;
    const answer = finalAnswerOf(run.events) || (run.status === "cancelled" ? "Stopped." : run.status === "error" ? "The run ended with an error." : "");
    if (!answer) return;
    sessions.appendMessage(sessionId, { messageId: runAnswerMessageId(runId), role: "assistant", content: answer, runId, mode: "agent" });
  };
  const run = store.get(runId);
  if (!run) return;
  if (isTerminal(run.status)) { save(); return; }
  const unsubscribe = store.subscribe(runId, (e) => {
    if (e.type === "run.completed" || e.type === "run.error" || e.type === "run.cancelled") {
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
    input: { userMessage: string; userMessageId?: string; assistantMessageId?: string; userCreatedAt?: number; mode?: string },
  ) {
    const mode = input.mode ?? "chat";
    sessions.appendMessage(sessionId, { messageId: input.userMessageId, role: "user", content: input.userMessage, mode, createdAt: input.userCreatedAt });
    const reply = sessions.appendMessage(sessionId, { messageId: input.assistantMessageId, role: "assistant", content: "", mode, status: "streaming" });
    this.replyId = reply?.messageId ?? null;
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
