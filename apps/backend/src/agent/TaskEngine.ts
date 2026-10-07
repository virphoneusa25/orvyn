// apps/backend/src/agent/TaskEngine.ts
//
// Missions and tasks. A mission is one user request ("build dark mode");
// tasks are the orchestrator's decomposition of it, each assigned to an agent
// role. This is deliberately a plain state machine — model calls live in the
// runtimes, not here — so mission state stays inspectable and testable.

import { randomUUID } from "crypto";
import type { AgentRole } from "../gateway/PermissionEngine";
import type { EventBus } from "./EventBus";
import type { TenantPersistence } from "../persistence/TenantPersistence";

export type TaskStatus =
  | "QUEUED"
  | "PLANNING"
  | "RUNNING"
  | "WAITING"
  | "TESTING"
  | "REVIEW"
  | "FAILED"
  | "REWORK"
  | "COMPLETED"
  | "BLOCKED"
  /** Never ran — a dependency failed or the plan had a cycle. Terminal. */
  | "SKIPPED";

export type MissionStatus = "QUEUED" | "PLANNING" | "RUNNING" | "REVIEW" | "COMPLETED" | "FAILED" | "BLOCKED";

export interface Task {
  id: string;
  missionId: string;
  description: string;
  /** Which specialist this task is assigned to. */
  agent: AgentRole;
  status: TaskStatus;
  attempts: number;
  /** Task ids that must reach COMPLETED before this task may run. */
  dependsOn?: string[];
  result?: string;
  reviewNotes?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TaskResult {
  ok: boolean;
  summary: string;
  /** Files the agent reported touching, when known. */
  changedFiles?: string[];
}

export interface Mission {
  id: string;
  /** The RunStore run this mission streams its events through. */
  runId: string;
  projectRoot: string;
  goal: string;
  status: MissionStatus;
  tasks: Task[];
  reviewCycles: number;
  createdAt: number;
  updatedAt: number;
}

const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["PLANNING", "RUNNING", "BLOCKED", "SKIPPED"],
  PLANNING: ["RUNNING", "FAILED", "BLOCKED"],
  RUNNING: ["WAITING", "TESTING", "REVIEW", "COMPLETED", "FAILED", "BLOCKED"],
  WAITING: ["RUNNING", "FAILED", "BLOCKED"],
  TESTING: ["REVIEW", "RUNNING", "FAILED", "BLOCKED"],
  REVIEW: ["COMPLETED", "REWORK", "FAILED", "BLOCKED"],
  REWORK: ["RUNNING", "FAILED", "BLOCKED"],
  FAILED: ["REWORK"],
  COMPLETED: [],
  BLOCKED: ["RUNNING", "REWORK"],
  SKIPPED: [],
};

export class TaskEngine {
  private missions = new Map<string, Mission>();


  readonly ready: Promise<void>;
  private writes: Promise<void> = Promise.resolve();

  constructor(private bus: EventBus, private store?: Pick<TenantPersistence, "loadMissions" | "saveMission">) {
    this.ready = this.hydrate();
    void this.ready.catch(() => {});
  }

  private async hydrate(): Promise<void> {
    const loaded = await this.store?.loadMissions() ?? [];
    for (const original of loaded) {
      const m = structuredClone(original);
      if (["QUEUED", "PLANNING", "RUNNING", "REVIEW"].includes(m.status)) {
        m.status = "FAILED";
        m.updatedAt = Date.now();
        await this.store?.saveMission(m);
      }
      this.missions.set(m.id, m);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.writes.then(async () => { await this.ready; return operation(); });
    this.writes = result.then(() => {}, () => {});
    return result;
  }

  private async commit(draft: Mission): Promise<Mission> {
    await this.store?.saveMission(draft);
    const existing = this.missions.get(draft.id);
    if (!existing) { this.missions.set(draft.id, draft); return draft; }
    const tasks = draft.tasks.map((task) => {
      const old = existing.tasks.find((t) => t.id === task.id);
      if (old) { Object.assign(old, task); return old; }
      return task;
    });
    Object.assign(existing, draft, { tasks });
    return existing;
  }

  async createMission(runId: string, projectRoot: string, goal: string): Promise<Mission> {
    return this.enqueue(async () => {
      const mission = await this.commit({ id: `mission_${randomUUID().slice(0, 8)}`, runId, projectRoot, goal,
        status: "QUEUED", tasks: [], reviewCycles: 0, createdAt: Date.now(), updatedAt: Date.now() });
      this.bus.missionCreated(mission);
      return mission;
    });
  }

  async getMission(id: string): Promise<Mission | undefined> { await this.ready; await this.writes; return this.missions.get(id); }
  async missionForRun(runId: string): Promise<Mission | undefined> { await this.ready; await this.writes; return [...this.missions.values()].find((m) => m.runId === runId); }
  async listMissions(): Promise<Mission[]> { await this.ready; await this.writes; return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt); }

  async setMissionStatus(missionId: string, status: MissionStatus): Promise<void> {
    return this.enqueue(async () => {
      const current = this.missions.get(missionId); if (!current) return;
      const m = await this.commit({ ...structuredClone(current), status, updatedAt: Date.now() });
      if (status === "RUNNING") this.bus.missionStarted(m);
      if (status === "COMPLETED" || status === "FAILED") this.bus.missionCompleted(m);
      if (status === "BLOCKED") this.bus.missionBlocked(m);
    });
  }

  async addTask(missionId: string, description: string, agent: AgentRole, dependsOn?: string[]): Promise<Task | undefined> {
    return this.enqueue(async () => {
      const current = this.missions.get(missionId); if (!current) return;
      const draft = structuredClone(current);
      const task: Task = { id: `task_${draft.tasks.length + 1}`, missionId, description, agent, status: "QUEUED", attempts: 0,
        ...(dependsOn?.length ? { dependsOn: [...dependsOn] } : {}), createdAt: Date.now(), updatedAt: Date.now() };
      draft.tasks.push(task); draft.updatedAt = Date.now();
      const m = await this.commit(draft);
      this.bus.taskCreated(m, task);
      return task;
    });
  }

  async transition(missionId: string, taskId: string, to: TaskStatus): Promise<Task> {
    return this.enqueue(async () => {
      const current = this.missions.get(missionId);
      const draft = current && structuredClone(current);
      const task = draft?.tasks.find((t) => t.id === taskId);
      if (!draft || !task) throw new Error(`Unknown task ${missionId}/${taskId}`);
      if (task.status !== to && !VALID_TRANSITIONS[task.status].includes(to)) throw new Error(`Invalid task transition ${task.status} → ${to} (${taskId})`);
      task.status = to; task.updatedAt = Date.now(); draft.updatedAt = Date.now();
      const committed = await this.commit(draft);
      return committed.tasks.find((t) => t.id === taskId)!;
    });
  }

  async incrementReviewCycles(missionId: string): Promise<number> {
    return this.enqueue(async () => {
      const current = this.missions.get(missionId); if (!current) return 0;
      const draft = structuredClone(current); draft.reviewCycles++; draft.updatedAt = Date.now();
      return (await this.commit(draft)).reviewCycles;
    });
  }

  /** Snapshot for the UI (Mission Control). */
  serialize(m: Mission) {
    return {
      id: m.id,
      runId: m.runId,
      goal: m.goal,
      status: m.status,
      reviewCycles: m.reviewCycles,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      tasks: m.tasks.map((t) => ({
        id: t.id,
        description: t.description,
        agent: t.agent,
        status: t.status,
        attempts: t.attempts,
        reviewNotes: t.reviewNotes,
        dependsOn: t.dependsOn,
      })),
    };
  }
}
