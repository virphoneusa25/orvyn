// packages/ai-core/src/router.ts
import { ModelRegistry } from "./registry";
import { AIModelProvider } from "./types";
import { incompatibility, preferHuggingFace, RoutingRequirements, RouteFamily } from "./autoRouting";

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
  private installationDefaults = new Set<string>();
  setDefaultOverride(task: TaskType, modelId: string): void { this.overrides[task] = modelId; this.installationDefaults.add(task); }
  private autoPolicy?: { enabled: () => boolean; unavailable: (id: string) => boolean };
  setAutoPolicy(policy: { enabled: () => boolean; unavailable: (id: string) => boolean }): void { this.autoPolicy = policy; }
  preferred(task: TaskType, needs: Partial<RoutingRequirements> = {}, family?: RouteFamily) {
    const explicit = this.overrides[task] && !this.installationDefaults.has(task);
    return preferHuggingFace(this.registry.list(), { capability: requiredCapability(task), ...needs }, !explicit && (this.autoPolicy?.enabled() ?? false), this.autoPolicy?.unavailable,
      family ?? (task === "chat" || task === "completion" || task === "reviewer" ? "flash" : task === "code" ? "code" : task === "agent" || task === "planner" || task === "executor" ? "advanced" : undefined));
  }
  constructor(
    private registry: ModelRegistry,
    private overrides: RoutingOverrides = {},
    private defaultModelId?: string
  ) {}

  setOverride(task: TaskType, modelId: string): void {
    this.installationDefaults.delete(task);
    this.overrides[task] = modelId;
  }

  clearOverride(task: TaskType): void {
    delete this.overrides[task];
  }

  getOverrides(): RoutingOverrides {
    return { ...this.overrides };
  }
  getExplicitOverrides(): RoutingOverrides { return Object.fromEntries(Object.entries(this.overrides).filter(([task]) => !this.installationDefaults.has(task))); }

  resolve(task: TaskType, needs: Partial<RoutingRequirements> = {}): AIModelProvider {
    const capability = TASK_CAPABILITY[task];
    const requirements = { capability, ...needs };
    const preferred = this.preferred(task, needs);
    // Overrides here are installation defaults. Explicit request ids are resolved by callers.
    if (preferred.provider && (!this.overrides[task] || this.installationDefaults.has(task))) return preferred.provider;
    const overrideId = this.overrides[task];
    if (overrideId) {
      const overridden = this.registry.get(overrideId);
      if (!this.installationDefaults.has(task)) {
        if (!overridden) throw new Error(`Explicit model ${overrideId} is not configured.`);
        const reason = incompatibility(overridden.config, requirements);
        if (reason) throw new Error(`Explicit model ${overrideId}: ${reason}.`);
        return overridden;
      }
      // An override that lacks the task's capability is ignored, not obeyed.
      // Without this, routing "chat" at an image-only model serves every
      // chat request a guaranteed 4xx from the provider.
      if (overridden && !incompatibility(overridden.config, requirements) && !this.autoPolicy?.unavailable(overridden.config.id) && (overridden.config.providerName !== "huggingface" || this.autoPolicy?.enabled())) return overridden;
      if (overridden) {
        console.warn(
          `Routing override "${task}" → "${overrideId}" ignored: model lacks the "${capability}" capability.`
        );
      }
    }

    const candidates = this.registry.findByCapability(capability).filter((p) => !incompatibility(p.config, requirements) && !this.autoPolicy?.unavailable(p.config.id) && (p.config.providerName !== "huggingface" || this.autoPolicy?.enabled()));
    if (candidates.length > 0) return candidates[0];

    if (this.defaultModelId) {
      const fallback = this.registry.get(this.defaultModelId);
      if (fallback && !incompatibility(fallback.config, requirements) && !this.autoPolicy?.unavailable(fallback.config.id) && (fallback.config.providerName !== "huggingface" || this.autoPolicy?.enabled())) return fallback;
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
      if (incompatibility(p.config, { capability: "agent", tools: true, vision: requireVision }) || this.autoPolicy?.unavailable(p.config.id)) return false;
      if (p.config.providerName === "huggingface" && !this.autoPolicy?.enabled()) return false;
      if (!p.config.capabilities.agent) return false;
      if (!this.supportsComputerUseViaTools(p)) return false;
      if (requireVision && !p.config.capabilities.vision) return false;
      return true;
    });
  }
}
