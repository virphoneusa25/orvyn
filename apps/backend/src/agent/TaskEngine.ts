// apps/backend/src/agent/TaskEngine.ts
//
// Missions and tasks. A mission is one user request ("build dark mode");
// tasks are the orchestrator's decomposition of it, each assigned to an agent
// role. This is deliberately a plain state machine — model calls live in the
// runtimes, not here — so mission state stays inspectable and testable.

import { randomUUID } from "crypto";
import type { AgentRole } from "../gateway/PermissionEngine";
import type { EventBus } from "./EventBus";
import type { LocalStore } from "../persistence/LocalStore";

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

export class TaskEngine {
  private missions = new Map<string, Mission>();

  constructor(private bus: EventBus, private store?: LocalStore) {
    // Warm-start mission history so Mission Control survives restarts.
    // Missions that were mid-flight when the process died can never resume
    // (their run loop is gone), so mark them FAILED rather than lying.
    if (store) {
      for (const m of store.loadMissions()) {
        if (m.status === "QUEUED" || m.status === "PLANNING" || m.status === "RUNNING" || m.status === "REVIEW") {
          m.status = "FAILED";
          m.updatedAt = Date.now();
          store.saveMission(m);
        }
        this.missions.set(m.id, m);
      }
    }
  }

  private persist(m: Mission): void {
    this.store?.saveMission(m);
  }

  createMission(runId: string, projectRoot: string, goal: string): Mission {
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
    this.persist(mission);
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

  setMissionStatus(missionId: string, status: MissionStatus): void {
    const m = this.missions.get(missionId);
    if (!m) return;
    m.status = status;
    m.updatedAt = Date.now();
    this.persist(m);
    if (status === "RUNNING") this.bus.missionStarted(m);
    if (status === "COMPLETED" || status === "FAILED") this.bus.missionCompleted(m);
    if (status === "BLOCKED") this.bus.missionBlocked(m);
  }

  addTask(missionId: string, description: string, agent: AgentRole): Task | undefined {
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
    this.persist(m);
    this.bus.taskCreated(m, task);
    return task;
  }

  /** Moves a task through the state machine; invalid jumps throw so bugs surface. */
  transition(missionId: string, taskId: string, to: TaskStatus): Task {
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
    this.persist(m);
    return task;
  }

  incrementReviewCycles(missionId: string): number {
    const m = this.missions.get(missionId);
    if (!m) return 0;
    m.reviewCycles++;
    this.persist(m);
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
