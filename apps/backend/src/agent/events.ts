// apps/backend/src/agent/events.ts
//
// The streaming event protocol. The chat is not a list of messages — it is an
// ordered log of typed events. Every event carries a monotonic `sequence`
// within its run, which is what makes reconnect/resume possible: a client that
// dropped at sequence 37 asks for everything after 37 rather than replaying the
// whole run.
//
// DURABILITY: when a directory is provided, every event is appended to
// `<dir>/<runId>.jsonl` as it is emitted and the newest logs are replayed at
// boot — a backend restart no longer erases finished runs' replayable
// history. In-flight runs still die with the process (reviving them needs
// the cloud tier's durable queue).

import { mkdirSync, appendFileSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, join } from "path";
import { detectDevServerUrls } from "../desktop/previewDetect";

export type AgentEventType =
  | "run.started"
  | "run.queued"
  | "message.delta"
  | "message.completed"
  | "message.grounded"
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
  | "artifact.created"
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
  | "sandbox.ready"
  | "sandbox.stopped"
  // --- Remote execution: where a run's tools execute (no local fallback) ---
  | "run.execution"
  // --- Steering: user instructions delivered at the next safe boundary ---
  | "steer.queued"
  | "steer.delivered"
  // --- Remote execution: where a run's tools execute (no local fallback) ---
  | "run.execution"
  // --- Durable ordered queue: follow-up instructions queued during a run ---
  | "queue.item.created"
  | "queue.item.updated"
  | "queue.item.reordered"
  | "queue.item.cancelled"
  | "queue.item.delivered"
  // --- MCP host lifecycle (server connect/disconnect; tool activity rides
  //     the standard tool.* events through the shared gateway) ---
  | "agent.phase"
  | "worker.started"
  | "worker.completed"
  | "worker.failed"
  | "worker.cancelled"
  | "browser.action"
  | "browser.completed"
  | "desktop.started"
  | "desktop.ready"
  | "desktop.control.changed"
  | "desktop.action"
  | "desktop.screenshot"
  | "desktop.completed"
  | "desktop.failed"
  | "preview.available"
  | "mcp.connected"
  | "mcp.disconnected"
  | "mcp.error"
  | "capability.required"
  | "mcp.activation";

export interface AgentEvent {
  id: string;
  runId: string;
  sequence: number;
  type: AgentEventType;
  timestamp: number;
  data: Record<string, unknown>;
}

export type RunStatus = "queued" | "running" | "awaiting_approval" | "completed" | "error" | "cancelled";

/** A durable, ordered follow-up instruction queued during a run. */
export interface QueueItem {
  id: string;
  runId: string;
  text: string;
  position: number;
  status: "queued" | "steered" | "delivered" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

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
  /** WHERE the run executes — LOCAL, DOCKER_LOCAL, or OVH_WORKER. */
  execution?: {
    executionLocation: string;
    reason?: string;
    containerId?: string;
    workerId?: string;
    startedAt?: number;
  };
}

/**
 * Runs are retained so a reconnecting client can replay them, but a long-lived
 * server would otherwise hold every event of every run forever. Finished runs
 * past this count are evicted oldest-first; live runs are never evicted.
 */
const MAX_RETAINED_RUNS = 100;

export class RunStore {
  private runs = new Map<string, Run>();
  private dir: string | null;
  private previewSeen = new Map<string, Set<string>>();

  constructor(dir?: string) {
    this.dir = dir ?? null;
    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true });
        this.loadRecentFromDisk();
      } catch {
        // Durability is best-effort: an unusable directory must never take
        // down the in-memory store that live runs depend on.
      }
    }
  }

  /** Appends one record to the run's log; disk failures are swallowed. */
  private log(runId: string, rec: Record<string, unknown>): void {
    if (!this.dir) return;
    try {
      appendFileSync(join(this.dir, `${runId}.jsonl`), JSON.stringify(rec) + "\n");
    } catch {
      /* a full disk must not break a live run */
    }
  }

  /** Boot replay: the newest MAX_RETAINED_RUNS logs return as real runs. */
  private loadRecentFromDisk(): void {
    const files = readdirSync(this.dir!)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ path: join(this.dir!, f), mtime: statSync(join(this.dir!, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_RETAINED_RUNS);
    for (const { path } of files) this.loadRunFile(path);
  }

  private loadRunFile(path: string): void {
    try {
      const runId = basename(path, ".jsonl");
      let run: Run | null = null;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let rec: any;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // torn tail write — skip the partial line
        }
        if (rec.t === "run" && !run) {
          run = {
            id: runId,
            projectRoot: String(rec.projectRoot ?? ""),
            status: (rec.status as RunStatus) ?? "running",
            createdAt: Number(rec.createdAt ?? Date.now()),
            events: [],
            nextSequence: 1,
            subscribers: new Set(),
            usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
            ...(rec.checkpointId ? { checkpointId: String(rec.checkpointId) } : {}),
          };
        } else if (rec.t === "run" && run) {
          // Later meta line = later status/checkpoint snapshot.
          run.status = (rec.status as RunStatus) ?? run.status;
          if (rec.checkpointId) run.checkpointId = String(rec.checkpointId);
        } else if (rec.t === "usage" && run) {
          run.usage = {
            promptTokens: Number(rec.promptTokens ?? 0),
            completionTokens: Number(rec.completionTokens ?? 0),
            turns: Number(rec.turns ?? 0),
          };
        } else if (rec.t === "ev" && run) {
          run.events.push(rec.e as AgentEvent);
          run.nextSequence = Math.max(run.nextSequence, (rec.e.sequence as number) + 1);
          this.replayQueueEvent(run.id, rec.e as AgentEvent);
        }
      }
      if (run) {
        // A run that was mid-flight when the process died can never progress
        // again — its runtime state is gone. Mark it honestly instead of
        // leaving a permanent "running"/"awaiting_approval" ghost.
        if (!isTerminal(run.status)) {
          const seq = run.nextSequence++;
          const ghost: AgentEvent = {
            id: `evt_${run.id.slice(0, 6)}_${seq}`,
            runId: run.id,
            sequence: seq,
            type: "run.error",
            timestamp: Date.now(),
            data: { message: "The backend restarted while this run was in flight. Retry to continue the work." },
          };
          run.events.push(ghost);
          run.status = "error";
          this.log(run.id, { t: "run", projectRoot: run.projectRoot, createdAt: run.createdAt, status: "error" });
          this.log(run.id, { t: "ev", e: ghost });
        }
        this.runs.set(run.id, run);
      }
    } catch {
      /* unreadable log = skip that run */
    }
  }

  create(id: string, projectRoot: string, status: RunStatus = "running", execution?: Run["execution"]): Run {
    const run: Run = {
      id,
      projectRoot,
      status,
      createdAt: Date.now(),
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      usage: { promptTokens: 0, completionTokens: 0, turns: 0 },
      execution,
    };
    this.runs.set(id, run);
    this.log(id, { t: "run", projectRoot, createdAt: run.createdAt, status });
    this.evictOldRuns();
    return run;
  }

  /**
   * Steering instructions queued for a live run. The store is shared by both
   * agent runtimes, so the queue lives HERE: whichever runtime makes the
   * run's next model call drains it — ownership never matters.
   */
  private steered = new Map<string, string[]>();

  /**
   * Durable ordered queue: structured follow-up instructions with identity,
   * position, and status. Survives restart (persisted via the JSONL log
   * meta). This replaces the old local-only React queue.
   */
  private queue = new Map<string, QueueItem[]>();

  steer(runId: string, text: string): boolean {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    const list = this.steered.get(runId) ?? [];
    list.push(trimmed);
    this.steered.set(runId, list);
    this.emit(runId, "steer.queued", { text: trimmed });
    return true;
  }

  takeSteer(runId: string): string[] {
    const list = this.steered.get(runId) ?? [];
    if (list.length === 0) return [];
    this.steered.delete(runId);
    for (const t of list) this.emit(runId, "steer.delivered", { text: t });
    return list;
  }

  // ---- Durable queue operations ---------------------------------------------

  /**
   * Boot replay for the durable queue: persisted queue.item.* events fold back
   * into the in-memory map, so a backend restart never loses follow-ups that
   * were queued during a live run. Event order in the log IS the queue's
   * history — replaying it reproduces the same items, text, and order.
   */
  private replayQueueEvent(runId: string, e: AgentEvent): void {
    if (!e.type.startsWith("queue.item.")) return;
    const items = this.queue.get(runId) ?? [];
    const id = String(e.data.id ?? "");
    if (e.type === "queue.item.created") {
      if (id && !items.some((i) => i.id === id)) {
        items.push({
          id,
          runId,
          text: String(e.data.text ?? ""),
          position: Number(e.data.position ?? items.length),
          status: "queued",
          createdAt: e.timestamp,
          updatedAt: e.timestamp,
        });
      }
    } else if (e.type === "queue.item.updated") {
      const item = items.find((i) => i.id === id);
      if (item) {
        item.text = String(e.data.text ?? item.text);
        item.updatedAt = e.timestamp;
      }
    } else if (e.type === "queue.item.reordered") {
      const order = Array.isArray(e.data.order) ? e.data.order.map(String) : [];
      const remaining = new Map(items.map((i) => [i.id, i]));
      const next: QueueItem[] = [];
      for (const orderedId of order) {
        const item = remaining.get(orderedId);
        if (item) {
          next.push({ ...item, position: next.length });
          remaining.delete(orderedId);
        }
      }
      for (const item of remaining.values()) next.push(item);
      this.queue.set(runId, next);
      return;
    } else if (e.type === "queue.item.cancelled" || e.type === "queue.item.delivered") {
      const idx = items.findIndex((i) => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
    }
    this.queue.set(runId, items);
  }

  queueAdd(runId: string, text: string): QueueItem | null {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return null;
    const trimmed = text.trim();
    if (!trimmed) return null;
    const items = this.queue.get(runId) ?? [];
    const item: QueueItem = {
      id: `q_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      runId,
      text: trimmed,
      position: items.length,
      status: "queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    items.push(item);
    this.queue.set(runId, items);
    this.emit(runId, "queue.item.created", { id: item.id, text: trimmed, position: item.position });
    return item;
  }

  queueList(runId: string): QueueItem[] {
    return [...(this.queue.get(runId) ?? [])]
      .filter((i) => i.status === "queued")
      .sort((a, b) => a.position - b.position);
  }

  queueReorder(runId: string, orderedIds: string[]): boolean {
    const items = this.queue.get(runId);
    if (!items) return false;
    const queued = items.filter((i) => i.status === "queued");
    if (orderedIds.length !== queued.length) return false;
    // Validate all IDs exist and are queued
    const queuedIds = new Set(queued.map((i) => i.id));
    for (const id of orderedIds) {
      if (!queuedIds.has(id)) return false;
    }
    // Atomically update positions
    orderedIds.forEach((id, idx) => {
      const item = items.find((i) => i.id === id);
      if (item) {
        item.position = idx;
        item.updatedAt = Date.now();
      }
    });
    this.emit(runId, "queue.item.reordered", { order: orderedIds });
    return true;
  }

  queueUpdate(runId: string, itemId: string, text: string): boolean {
    const items = this.queue.get(runId);
    if (!items) return false;
    const item = items.find((i) => i.id === itemId && i.status === "queued");
    if (!item) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;
    item.text = trimmed;
    item.updatedAt = Date.now();
    this.emit(runId, "queue.item.updated", { id: itemId, text: trimmed });
    return true;
  }

  queueDelete(runId: string, itemId: string): boolean {
    const items = this.queue.get(runId);
    if (!items) return false;
    const item = items.find((i) => i.id === itemId && i.status === "queued");
    if (!item) return false;
    item.status = "cancelled";
    item.updatedAt = Date.now();
    this.emit(runId, "queue.item.cancelled", { id: itemId });
    return true;
  }

  /** Steers a queued item immediately: removes from queue, injects into the run. */
  queueSteer(runId: string, itemId: string): boolean {
    const run = this.runs.get(runId);
    if (!run || isTerminal(run.status)) return false;
    const items = this.queue.get(runId);
    if (!items) return false;
    const item = items.find((i) => i.id === itemId && i.status === "queued");
    if (!item) return false;
    item.status = "steered";
    item.updatedAt = Date.now();
    // Inject into the steer mechanism for delivery at the next model boundary
    const steerList = this.steered.get(runId) ?? [];
    steerList.push(item.text);
    this.steered.set(runId, steerList);
    this.emit(runId, "queue.item.delivered", { id: itemId, text: item.text, method: "steered" });
    return true;
  }

  /**
   * Marks an item delivered — consumed outside the queue. The desktop sends
   * the follow-up as a NEW run once the current one settles; recording the
   * delivery keeps the event log honest (delivered, not cancelled).
   */
  queueMarkDelivered(runId: string, itemId: string): boolean {
    const items = this.queue.get(runId);
    if (!items) return false;
    const item = items.find((i) => i.id === itemId && i.status === "queued");
    if (!item) return false;
    item.status = "delivered";
    item.updatedAt = Date.now();
    this.emit(runId, "queue.item.delivered", { id: itemId, text: item.text, method: "followup" });
    return true;
  }

  /** Takes the next queued item by position (for auto-delivery). Returns null if empty. */
  queueTakeNext(runId: string): QueueItem | null {
    const next = this.queueList(runId)[0];
    if (!next) return null;
    next.status = "delivered";
    next.updatedAt = Date.now();
    // Also push into steer so the runtime picks it up
    const steerList = this.steered.get(runId) ?? [];
    steerList.push(next.text);
    this.steered.set(runId, steerList);
    this.emit(runId, "queue.item.delivered", { id: next.id, text: next.text, method: "auto" });
    return next;
  }

  queueCleanup(runId: string): void {
    this.queue.delete(runId);
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
    this.log(runId, { t: "usage", ...run.usage });
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
    this.log(runId, { t: "ev", e: event });

    for (const send of run.subscribers) {
      try {
        send(event);
      } catch {
        // A broken subscriber must not break the run or other subscribers.
      }
    }
    if (type !== "preview.available") this.emitPreviewFromText(runId, type, data);
    return event;
  }

  private emitPreviewFromText(runId: string, type: AgentEventType, data: Record<string, unknown>): void {
    if (type !== "terminal.output" && type !== "terminal.started" && type !== "tool.completed") return;
    const text = String(data.data ?? data.chunk ?? data.output ?? data.preview ?? data.command ?? data.content ?? "");
    const seen = this.previewSeen.get(runId) ?? new Set<string>();
    this.previewSeen.set(runId, seen);
    for (const preview of detectDevServerUrls(text)) {
      if (seen.has(preview.url)) continue;
      seen.add(preview.url);
      this.emit(runId, "preview.available", {
        url: preview.url,
        label: preview.label,
        port: preview.port,
        source: "dev-server",
      });
    }
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
    if (!run) return;
    run.status = status;
    this.log(runId, { t: "run", projectRoot: run.projectRoot, createdAt: run.createdAt, status, ...(run.checkpointId ? { checkpointId: run.checkpointId } : {}) });
  }

  setCheckpoint(runId: string, checkpointId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.checkpointId = checkpointId;
    this.log(runId, { t: "run", projectRoot: run.projectRoot, createdAt: run.createdAt, status: run.status, checkpointId });
  }

  list(): Run[] {
    return Array.from(this.runs.values());
  }
}
