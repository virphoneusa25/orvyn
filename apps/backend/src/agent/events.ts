// apps/backend/src/agent/events.ts
//
// The streaming event protocol. The chat is not a list of messages — it is an
// ordered log of typed events. Every event carries a monotonic `sequence`
// within its run, which is what makes reconnect/resume possible: a client that
// dropped at sequence 37 asks for everything after 37 rather than replaying the
// whole run.

export type AgentEventType =
  | "run.started"
  | "message.delta"
  | "message.completed"
  | "thinking"
  | "tool.started"
  | "tool.input"
  | "tool.completed"
  | "tool.failed"
  | "file.read"
  | "file.edit"
  | "terminal.started"
  | "terminal.output"
  | "terminal.completed"
  | "image.generated"
  | "context.updated"
  | "approval.required"
  | "approval.resolved"
  | "run.completed"
  | "plan.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "review.started"
  | "review.passed"
  | "review.rejected"
  | "run.error"
  | "run.cancelled"
  /** Rolling token/cost accounting for the run. */
  | "usage.updated"
  /** History was elided to stay inside the model's context window. */
  | "context.compacted"
  // --- ORVYN Intelligence mission/agent lifecycle (Event Bus, Phase 2+) ---
  | "mission.created"
  | "mission.started"
  | "mission.completed"
  | "mission.blocked"
  | "task.created"
  | "agent.started"
  | "agent.status"
  | "agent.completed"
  | "agent.tool_call"
  | "test.started"
  | "test.completed"
  | "review.approved"
  | "checkpoint.created"
  | "checkpoint.restored"
  // --- Sandbox execution (cloud missions run commands in Docker) ---
  | "sandbox.started"
  | "sandbox.stopped";

export interface AgentEvent {
  id: string;
  runId: string;
  sequence: number;
  type: AgentEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type RunStatus = "running" | "awaiting_approval" | "completed" | "error" | "cancelled";

/** A run is finished when no further events can arrive for it. */
export function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "error" || status === "cancelled";
}

export interface Run {
  id: string;
  projectRoot: string;
  status: RunStatus;
  createdAt: number;
  events: AgentEvent[];
  /** Incremented per emitted event; the client's resume cursor. */
  nextSequence: number;
  /** Live subscribers (open SSE/WS connections). */
  subscribers: Set<(e: AgentEvent) => void>;
  /** Rolling token totals, accumulated from each model turn. */
  usage: { promptTokens: number; completionTokens: number; turns: number };
  /** Pre-run snapshot backing the run's Undo button, when one could be made. */
  checkpointId?: string;
}

/**
 * Runs are retained so a reconnecting client can replay them, but a long-lived
 * server would otherwise hold every event of every run forever. Finished runs
 * past this count are evicted oldest-first; live runs are never evicted.
 */
const MAX_RETAINED_RUNS = 100;

export class RunStore {
  private runs = new Map<string, Run>();

  create(id: string, projectRoot: string): Run {
    const run: Run = {
      id,
      projectRoot,
      status: "running",
      createdAt: Date.now(),
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
    };
    this.runs.set(id, run);
    this.evictOldRuns();
    return run;
  }

  /** Drops the oldest finished runs once retention is exceeded. */
  private evictOldRuns(): void {
    if (this.runs.size <= MAX_RETAINED_RUNS) return;
    const finished = Array.from(this.runs.values())
      .filter((r) => isTerminal(r.status) && r.subscribers.size === 0)
      .sort((a, b) => a.createdAt - b.createdAt);
    let excess = this.runs.size - MAX_RETAINED_RUNS;
    for (const run of finished) {
      if (excess <= 0) break;
      this.runs.delete(run.id);
      excess--;
    }
  }

  /** Accumulates token usage for a run and returns the running total. */
  addUsage(runId: string, usage: { promptTokens: number; completionTokens: number }): Run["usage"] | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    run.usage.promptTokens += usage.promptTokens;
    run.usage.completionTokens += usage.completionTokens;
    run.usage.turns++;
    return { ...run.usage };
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  // Appends to the durable log FIRST, then fans out to live subscribers. Doing
  // it in this order means a subscriber that throws (or a socket that died)
  // can never cause an event to be lost from the replayable history.
  emit(runId: string, type: AgentEventType, data: Record<string, unknown> = {}): AgentEvent | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;

    const event: AgentEvent = {
      id: `evt_${runId.slice(0, 6)}_${run.nextSequence}`,
      runId,
      sequence: run.nextSequence++,
      type,
      timestamp: Date.now(),
      data,
    };
    run.events.push(event);

    for (const send of run.subscribers) {
      try {
        send(event);
      } catch {
        // A broken subscriber must not break the run or other subscribers.
      }
    }
    return event;
  }

  /** Replay for reconnecting clients: everything strictly after `afterSequence`. */
  eventsAfter(runId: string, afterSequence: number): AgentEvent[] {
    const run = this.runs.get(runId);
    if (!run) return [];
    return run.events.filter((e) => e.sequence > afterSequence);
  }

  subscribe(runId: string, fn: (e: AgentEvent) => void): () => void {
    const run = this.runs.get(runId);
    if (!run) return () => {};
    run.subscribers.add(fn);
    return () => run.subscribers.delete(fn);
  }

  setStatus(runId: string, status: RunStatus): void {
    const run = this.runs.get(runId);
    if (run) run.status = status;
  }

  setCheckpoint(runId: string, checkpointId: string): void {
    const run = this.runs.get(runId);
    if (run) run.checkpointId = checkpointId;
  }

  list(): Run[] {
    return Array.from(this.runs.values());
  }
}
