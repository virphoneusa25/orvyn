// apps/backend/src/agent/Agent.ts
//
// The shared contract every ORVYN specialist implements. Workers never call
// each other — results return to the orchestrator through the Task Engine.
// Tools are reached only through the Tool Gateway (name list + capability
// role); models only through the Model Gateway (modelTask, never a vendor id).

import type { AgentRole, Capability } from "../gateway/PermissionEngine";
import type { AgentEvent } from "./events";
import type { Task, TaskResult } from "./TaskEngine";
import { playwrightAvailable, PLAYWRIGHT_MISSING } from "../ai/tools/browserTools";

export type AgentModelTask = "planner" | "reviewer" | "executor" | "chat" | "vision";

export type AgentState = "idle" | "working" | "waiting_approval" | "blocked" | "error";

export interface TaskContext {
  projectRoot: string;
  missionId: string;
  /** Free-form rules/notes threaded from the mission (project rules, prior results). */
  notes?: string;
}

export interface Agent {
  id: string;
  role: AgentRole;
  modelTask: AgentModelTask;
  /** Tool names this agent may request through the gateway. */
  tools: string[];
  permissions: Capability[];
  context: TaskContext | null;
  task: Task | null;
  state: AgentState;
  history: AgentEvent[];
  execute(task: Task): Promise<TaskResult>;
}

/**
 * Roster metadata for agents whose execute() is not implemented yet.
 * The UI must show these as Pending (disabled), never as clickable fakes.
 */
export interface AgentDescriptor {
  role: AgentRole;
  label: string;
  modelTask: AgentModelTask;
  status: "ready" | "pending";
  pendingReason?: string;
}

export function defaultRoster(): AgentDescriptor[] {
  return [
    { role: "orchestrator", label: "Astra (orchestrator)", modelTask: "planner", status: "ready" },
    { role: "coder", label: "Coding Agent", modelTask: "executor", status: "ready" },
    { role: "tester", label: "Testing Agent", modelTask: "executor", status: "ready" },
    { role: "research", label: "Research Agent", modelTask: "chat", status: "ready" },
    { role: "git", label: "Git Agent", modelTask: "executor", status: "ready" },
    playwrightAvailable()
      ? { role: "browser" as const, label: "Browser QA Agent", modelTask: "executor" as const, status: "ready" as const }
      : {
          role: "browser" as const,
          label: "Browser QA Agent",
          modelTask: "executor" as const,
          status: "pending" as const,
          pendingReason: PLAYWRIGHT_MISSING,
        },
    { role: "security", label: "Security Agent", modelTask: "reviewer", status: "ready" },
  ];
}
