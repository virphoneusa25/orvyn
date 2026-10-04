// apps/backend/src/agent/TaskEngine.ts
//
// Missions and tasks. A mission is one user request ("build dark mode");
// tasks are the orchestrator's decomposition of it, each assigned to an agent
// role. This is deliberately a plain state machine — model calls live in the
// runtimes, not here — so mission state stays inspectable and testable.

import { randomUUID } from "crypto";
import type { AgentRole } from "../gateway/PermissionEngine";
import type { EventBus } from "./EventBus";
import type { TenantStore } from "../persistence/TenantStore";

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
  | "BLOCKED";

export type MissionStatus = "QUEUED" | "PLANNING" | "RUNNING" | "REVIEW" | "COMPLETED" | "FAILED" | "BLOCKED";

export interface Task {
  id: string;
  missionId: string;
  description: string;
  /** Which specialist this task is assigned to. */
  agent: AgentRole;
  status: TaskStatus;
  attempts: number;
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
  QUEUED: ["PLANNING", "RUNNING", "BLOCKED"],
  PLANNING: ["RUNNING", "FAILED", "BLOCKED"],
  RUNNING: ["WAITING", "TESTING", "REVIEW", "COMPLETED", "FAILED", "BLOCKED"],
  WAITING: ["RUNNING", "FAILED", "BLOCKED"],
  TESTING: ["REVIEW", "RUNNING", "FAILED", "BLOCKED"],
  REVIEW: ["COMPLETED", "REWORK", "FAILED", "BLOCKED"],
  REWORK: ["RUNNING", "FAILED", "BLOCKED"],
  FAILED: ["REWORK"],
  COMPLETED: [],
  BLOCKED: ["RUNNING", "REWORK"],
};

export interface TaskEngineOptions {
  /**
   * Called only during constructor warm-start for persisted in-flight missions.
   * Local single-process runtimes return true (old behavior); distributed API
   * and worker contexts can preserve missions still owned by BullMQ workers.
   */
  shouldFailRecoveredMission?: (mission: Mission) => boolean;
}

export class TaskEngine {
  private missions = new Map<string, Mission>();

  constructor(
    private bus: EventBus,
    private store?: TenantStore,
    private options: TaskEngineOptions = {}
  ) {}

  private isInFlight(status: MissionStatus): boolean {
    return status === "QUEUED" || status === "PLANNING" || status === "RUNNING" || status === "REVIEW";
  }

  /**
   * Must be awaited once after construction. TenantManager owns this lifecycle
   * so no request can observe a partially hydrated mission map.
   */
  async hydrate(): Promise<void> {
    await this.loadFromStore(true);
  }

  /**
   * Refresh persisted state without applying warm-start failure semantics.
   * API Mission Control calls this before reads in distributed mode so worker
   * updates become visible across processes.
   */
  async refresh(): Promise<void> {
    await this.loadFromStore(false);
  }

  private async loadFromStore(warmStart: boolean): Promise<void> {
    if (!this.store) return;

    for (const persisted of await this.store.loadMissions()) {
      const m: Mission = persisted;

      if (
        warmStart &&
        this.isInFlight(m.status) &&
        (this.options.shouldFailRecoveredMission?.(m) ?? true)
      ) {
        m.status = "FAILED";
        m.updatedAt = Date.now();
        await this.store.saveMission(m);
      }

      const current = this.missions.get(m.id);
      if (!current || m.updatedAt >= current.updatedAt) {
        this.missions.set(m.id, m);
      }
    }
  }

  private async persist(m: Mission): Promise<void> {
    await this.store?.saveMission(m);
  }

  async createMission(runId: string, projectRoot: string, goal: string): Promise<Mission> {
    const mission: Mission = {
      id: `mission_${randomUUID().slice(0, 8)}`,
      runId,
      projectRoot,
      goal,
      status: "QUEUED",
      tasks: [],
      reviewCycles: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.missions.set(mission.id, mission);
    await this.persist(mission);
    this.bus.missionCreated(mission);
    return mission;
  }

  getMission(id: string): Mission | undefined {
    return this.missions.get(id);
  }

  missionForRun(runId: string): Mission | undefined {
    for (const m of this.missions.values()) if (m.runId === runId) return m;
    return undefined;
  }

  listMissions(): Mission[] {
    return Array.from(this.missions.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  async setMissionStatus(missionId: string, status: MissionStatus): Promise<void> {
    const m = this.missions.get(missionId);
    if (!m) return;
    m.status = status;
    m.updatedAt = Date.now();
    await this.persist(m);
    if (status === "RUNNING") this.bus.missionStarted(m);
    if (status === "COMPLETED" || status === "FAILED") this.bus.missionCompleted(m);
    if (status === "BLOCKED") this.bus.missionBlocked(m);
  }

  async addTask(missionId: string, description: string, agent: AgentRole): Promise<Task | undefined> {
    const m = this.missions.get(missionId);
    if (!m) return undefined;
    const task: Task = {
      id: `task_${m.tasks.length + 1}`,
      missionId,
      description,
      agent,
      status: "QUEUED",
      attempts: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    m.tasks.push(task);
    m.updatedAt = Date.now();
    await this.persist(m);
    this.bus.taskCreated(m, task);
    return task;
  }

  /** Moves a task through the state machine; invalid jumps throw so bugs surface. */
  async transition(missionId: string, taskId: string, to: TaskStatus): Promise<Task> {
    const m = this.missions.get(missionId);
    const task = m?.tasks.find((t) => t.id === taskId);
    if (!m || !task) throw new Error(`Unknown task ${missionId}/${taskId}`);
    if (task.status !== to && !VALID_TRANSITIONS[task.status].includes(to)) {
      throw new Error(`Invalid task transition ${task.status} → ${to} (${taskId})`);
    }
    task.status = to;
    task.updatedAt = Date.now();
    m.updatedAt = Date.now();
    // Transitions happen right after result/attempt mutations in the runtime,
    // so persisting here also captures those fields.
    await this.persist(m);
    return task;
  }

  async incrementReviewCycles(missionId: string): Promise<number> {
    const m = this.missions.get(missionId);
    if (!m) return 0;
    m.reviewCycles++;
    await this.persist(m);
    return m.reviewCycles;
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
      })),
    };
  }
}
