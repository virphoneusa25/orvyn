// apps/backend/src/agent/EventBus.ts
//
// Mission/agent lifecycle events, expressed over the EXISTING RunStore rather
// than a second socket. Every mission is bound to a run, so the UI keeps its
// one SSE subscription (`/agent/stream/runs/:id/events`) and simply receives
// richer event types. This wrapper exists so engines emit strongly-named
// events instead of scattering string literals.

import type { RunStore } from "./events";
import type { Mission, Task } from "./TaskEngine";
import type { AgentRole } from "../gateway/PermissionEngine";

export class EventBus {
  constructor(public readonly store: RunStore) {}

  missionCreated(m: Mission): void {
    this.store.emit(m.runId, "mission.created", { missionId: m.id, goal: m.goal, projectRoot: m.projectRoot });
  }

  missionStarted(m: Mission): void {
    this.store.emit(m.runId, "mission.started", { missionId: m.id, tasks: m.tasks.length });
  }

  missionCompleted(m: Mission): void {
    this.store.emit(m.runId, "mission.completed", {
      missionId: m.id,
      status: m.status,
      tasks: m.tasks.map((t) => ({ id: t.id, status: t.status })),
    });
  }

  missionBlocked(m: Mission): void {
    this.store.emit(m.runId, "mission.blocked", {
      missionId: m.id,
      reviewCycles: m.reviewCycles,
      reason: "Review cycle limit reached — human decision required",
    });
  }

  taskCreated(m: Mission, t: Task): void {
    this.store.emit(m.runId, "task.created", {
      missionId: m.id,
      taskId: t.id,
      description: t.description,
      agent: t.agent,
    });
  }

  agentStarted(runId: string, role: AgentRole, taskId: string, modelId: string): void {
    this.store.emit(runId, "agent.started", { agent: role, taskId, model: modelId });
  }

  agentStatus(runId: string, role: AgentRole, state: string, taskId?: string): void {
    this.store.emit(runId, "agent.status", { agent: role, state, taskId });
  }

  agentCompleted(runId: string, role: AgentRole, taskId: string, ok: boolean): void {
    this.store.emit(runId, "agent.completed", { agent: role, taskId, ok });
  }

  agentToolCall(runId: string, role: AgentRole, tool: string, taskId?: string): void {
    this.store.emit(runId, "agent.tool_call", { agent: role, tool, taskId });
  }

  testStarted(runId: string, kind: string, taskId?: string): void {
    this.store.emit(runId, "test.started", { kind, taskId });
  }

  testCompleted(runId: string, kind: string, ok: boolean, summary: string, taskId?: string): void {
    this.store.emit(runId, "test.completed", { kind, ok, summary: summary.slice(0, 600), taskId });
  }

  reviewApproved(runId: string, missionId: string, score: number): void {
    this.store.emit(runId, "review.approved", { missionId, score });
  }

  checkpointCreated(runId: string, checkpointId: string, files: number): void {
    this.store.emit(runId, "checkpoint.created", { checkpointId, files });
  }

  checkpointRestored(runId: string, checkpointId: string): void {
    this.store.emit(runId, "checkpoint.restored", { checkpointId });
  }
}
