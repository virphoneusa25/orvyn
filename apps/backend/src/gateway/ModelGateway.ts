// apps/backend/src/gateway/ModelGateway.ts
//
// Role → model resolution. Agent code asks for a ROLE ("orchestrator",
// "coder", …), never a vendor or model ID. The mapping goes through the
// existing ModelRouter tasks, so ORCHESTRATOR_MODEL / DeepSeek presets /
// user overrides in Settings all take effect without touching agent code.
// There must never be an `if (model === "deepseek")` anywhere above this file.

import { AIModelProvider, AIRequest, AIResponse, TaskType } from "@orvyn/ai-core";
import { ModelService } from "../services/ModelService";
import type { AgentRole } from "./PermissionEngine";

/** Which router task each agent role runs on. Astra = planner/reviewer, not a SKU. */
const ROLE_TASK: Record<AgentRole, TaskType> = {
  orchestrator: "planner",
  coder: "executor",
  tester: "executor",
  browser: "executor",
  security: "reviewer",
  research: "chat",
  git: "executor",
};

export class ModelGateway {
  constructor(private models: ModelService) {}

  taskFor(role: AgentRole): TaskType {
    return ROLE_TASK[role];
  }

  resolveRole(role: AgentRole): AIModelProvider {
    return this.models.router.resolve(ROLE_TASK[role]);
  }

  resolveTask(task: TaskType): AIModelProvider {
    return this.models.router.resolve(task);
  }

  /** One-shot generate on whatever model currently backs the role. */
  async run(role: AgentRole, request: AIRequest): Promise<AIResponse> {
    return this.resolveRole(role).generate(request);
  }

  /** Routing table for the UI — which model id each role resolves to right now. */
  describe(): { role: AgentRole; task: TaskType; modelId: string | null }[] {
    return (Object.keys(ROLE_TASK) as AgentRole[]).map((role) => {
      let modelId: string | null = null;
      try {
        modelId = this.resolveRole(role).config.id;
      } catch {
        modelId = null;
      }
      return { role, task: ROLE_TASK[role], modelId };
    });
  }
}
