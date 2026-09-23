// packages/ai-core/src/router.ts
import { ModelRegistry } from "./registry";
import { AIModelProvider } from "./types";

export type TaskType =
  | "chat"
  | "code"
  | "completion"
  | "embedding"
  | "agent"
  | "vision"
  | "image"
  | "planner"
  | "executor"
  | "reviewer";

export interface RoutingOverrides {
  [taskType: string]: string; // taskType -> modelId
}

// Default capability each task type needs, in priority order.
const TASK_CAPABILITY: Record<TaskType, keyof AIModelProvider["config"]["capabilities"]> = {
  chat: "chat",
  code: "code",
  completion: "completion",
  embedding: "embeddings",
  agent: "agent",
  vision: "vision",
  image: "image",
  planner: "agent",
  executor: "agent",
  reviewer: "chat",
};

/** The capability a model must have to serve a given task. */
export function requiredCapability(task: TaskType): keyof AIModelProvider["config"]["capabilities"] {
  return TASK_CAPABILITY[task] ?? "chat";
}

export class ModelRouter {
  constructor(
    private registry: ModelRegistry,
    private overrides: RoutingOverrides = {},
    private defaultModelId?: string
  ) {}

  setOverride(task: TaskType, modelId: string): void {
    this.overrides[task] = modelId;
  }

  clearOverride(task: TaskType): void {
    delete this.overrides[task];
  }

  getOverrides(): RoutingOverrides {
    return { ...this.overrides };
  }

  resolve(task: TaskType): AIModelProvider {
    const capability = TASK_CAPABILITY[task];
    const overrideId = this.overrides[task];
    if (overrideId) {
      const overridden = this.registry.get(overrideId);
      // An override that lacks the task's capability is ignored, not obeyed.
      // Without this, routing "chat" at an image-only model serves every
      // chat request a guaranteed 4xx from the provider.
      if (overridden?.config.capabilities[capability]) return overridden;
      if (overridden) {
        console.warn(
          `Routing override "${task}" → "${overrideId}" ignored: model lacks the "${capability}" capability.`
        );
      }
    }

    const candidates = this.registry.findByCapability(capability);
    if (candidates.length > 0) return candidates[0];

    if (this.defaultModelId) {
      const fallback = this.registry.get(this.defaultModelId);
      if (fallback) return fallback;
    }

    throw new Error(
      `No model available for task "${task}" (needs capability "${capability}"). Configure one in Settings > AI Models.`
    );
  }

  /** ORVYN computer-use via tools (vision + tool calling). Not a separate "computer model". */
  supportsComputerUseViaTools(provider: AIModelProvider): boolean {
    const c = provider.config.capabilities;
    return c.tools === true && c.computerUseViaTools !== false;
  }

  findComputerUseCompatible(opts?: { requireVision?: boolean; excludeId?: string }): AIModelProvider | undefined {
    const requireVision = opts?.requireVision !== false;
    return this.registry.list().find((p) => {
      if (opts?.excludeId && p.config.id === opts.excludeId) return false;
      if (!p.config.capabilities.agent) return false;
      if (!this.supportsComputerUseViaTools(p)) return false;
      if (requireVision && !p.config.capabilities.vision) return false;
      return true;
    });
  }
}
