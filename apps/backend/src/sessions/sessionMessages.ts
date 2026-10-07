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
import type { SessionMessage, WorkSessionPersistence as WorkSessionStore } from "./WorkSessionStore";
import type { TurnDecision } from "@orvyn/ai-core";

/** Stable ids, so a retry or a second writer updates instead of duplicating. */
export const runAnswerMessageId = (runId: string) => `msg_answer_${runId}`;

export async function recordRunInstruction(
  sessions: WorkSessionStore,
  sessionId: string,
  runId: string,
  instruction: string,
  opts: { messageId?: string; mode?: string; turnDecision?: TurnDecision } = {},
): Promise<SessionMessage | undefined> {
  if (!instruction.trim()) return undefined;
  return await sessions.appendMessage(sessionId, {
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
  const save = async () => {
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
    await sessions.appendMessage(sessionId, { messageId: runAnswerMessageId(runId), role: "assistant", content: answer, runId, mode: "agent" });
    const artifacts: { artifactId: string; name: string; mimeType: string }[] = [];
    const seen = new Set<string>();
    for (const e of run.events) {
      if (e.type !== "artifact.created" && e.type !== "image.generated") continue;
      const artifactId = String(e.data?.artifactId ?? e.data?.id ?? "");
      if (!artifactId || seen.has(artifactId)) continue;
      seen.add(artifactId);
      artifacts.push({
        artifactId,
        name: String(e.data?.name ?? e.data?.filename ?? "file"),
        mimeType: String(e.data?.mimeType ?? e.data?.mediaType ?? "application/octet-stream"),
      });
    }
    if (artifacts.length) await sessions.updateMessage(runAnswerMessageId(runId), { meta: { artifacts } });
  };
  const run = store.get(runId);
  if (!run) return;
  if (shouldPersistFinalAnswer(run)) { void save().catch(() => console.warn("[sessions] final answer persistence failed")); return; }
  const unsubscribe = store.subscribe(runId, (e) => {
    // A mid-run block pauses for a resource — the answer isn't final yet.
    // Only a settlement-emitted (terminal) block ends the capture.
    const terminalBlock = e.type === "run.blocked" && e.data.terminal === true;
    if (e.type === "run.completed" || e.type === "run.partial" || e.type === "run.error" || e.type === "run.cancelled" || terminalBlock) {
      unsubscribe();
      // After the event is in the log, so the answer includes the last words.
      setImmediate(() => { void save().catch(() => console.warn("[sessions] final answer persistence failed")); });
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
  readonly ready: Promise<void>;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;
  private failed = false;

  private write(operation: () => unknown | Promise<unknown>): void {
    this.pending = this.pending.then(async () => {
      if (this.failed) return;
      try { await operation(); } catch (error) { this.failed = true; this.failure = error; }
    });
  }
  private async drain(): Promise<void> {
    let pending: Promise<void>;
    do { pending = this.pending; await pending; } while (pending !== this.pending);
    if (this.failed) throw this.failure;
  }

  constructor(
    private readonly sessions: WorkSessionStore,
    private readonly sessionId: string,
    input: { userMessage: string; userMessageId?: string; assistantMessageId?: string; userCreatedAt?: number; mode?: string; attachments?: unknown[]; turnDecision?: TurnDecision },
  ) {
    const mode = input.mode ?? "chat";
    this.write(async () => {
      const user = await sessions.appendMessage(sessionId, {
        messageId: input.userMessageId, role: "user", content: input.userMessage, mode, createdAt: input.userCreatedAt,
        ...(input.attachments?.length || input.turnDecision ? { meta: { ...(input.attachments?.length ? { attachments: input.attachments } : {}), ...(input.turnDecision ? { turnDecision: input.turnDecision } : {}) } } : {}),
      });
      if (!user) throw new Error("Conversation instruction could not be stored");
      const reply = await sessions.appendMessage(sessionId, { messageId: input.assistantMessageId, role: "assistant", content: "", mode, status: "streaming" });
      if (!reply) throw new Error("Conversation reply could not be stored");
      this.replyId = reply.messageId;
    });
    this.ready = this.drain();
    void this.ready.catch(() => {}); // caller awaits ready before paid inference
  }

  private activities: unknown[] = [];

  /** A web search or page read during the reply (kept with the reply, for restore). */
  activity(a: { id: string }): void {
    if (this.done) return;
    const i = this.activities.findIndex((x) => (x as { id: string }).id === a.id);
    if (i >= 0) this.activities[i] = a; else this.activities.push(a);
    const activity = JSON.parse(JSON.stringify(this.activities));
    this.write(() => this.sessions.updateMessage(this.replyId!, { meta: { activity } }));
  }

  /** Files the reply produced (e.g. a generated image), kept with the reply. */
  artifacts(list: unknown[]): void {
    if (this.done || !list.length) return;
    const artifacts = JSON.parse(JSON.stringify(list));
    this.write(() => this.sessions.updateMessage(this.replyId!, { meta: { artifacts } }));
  }
  routing(routing: { provider: string; modelId: string; reason: string }): void {
    if (this.done) return;
    this.write(() => this.sessions.updateMessage(this.replyId!, { meta: { routing: { ...routing } } }));
  }

  /** The reply so far was withdrawn (ORION researches first). The persisted
   *  copy is cleared too — an autosave may already have written the retracted
   *  text, and a crash must not resurrect it. */
  retract(): void {
    if (this.done) return;
    this.text = "";
    this.write(() => this.sessions.updateMessage(this.replyId!, { content: "" }));
  }

  delta(chunk: string): void {
    if (this.done || !chunk) return;
    this.text += chunk;
    if (Date.now() - this.lastSave > ChatTurnRecorder.SAVE_EVERY_MS) {
      this.lastSave = Date.now();
      const content = this.text;
      this.write(() => this.sessions.updateMessage(this.replyId!, { content }));
    }
  }

  async finish(error?: string): Promise<void> {
    if (this.done) return this.drain();
    this.done = true;
    const content = error ? `${this.text}${this.text ? "\n\n" : ""}${error}` : this.text;
    this.write(() => this.sessions.updateMessage(this.replyId!, { content, status: "complete" }));
    await this.drain();
  }
}
