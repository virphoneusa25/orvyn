// Certified lanes. Capabilities are declared here, not guessed from the model name.
// Registry ids stay stable; the provider wire id is separate.

export interface LaneModel {
  lane:
    | "fast"
    | "fast-secondary"
    | "auto"
    | "engineering"
    | "frontend"
    | "premium"
    | "premium-alt"
    | "image"
    | "image-quality";
  registryId: string;
  apiModelId: string;
  provider: "fireworks" | "cheaper-inference";
  contextWindow: number;
  tools: boolean;
  vision: boolean;
  agent: boolean;
  image: boolean;
  imageEditing: boolean;
}

export const CERTIFIED_MODELS: LaneModel[] = [
  {
    lane: "fast",
    registryId: "ci:gpt-5.6-luna",
    apiModelId: "gpt-5.6-luna",
    provider: "cheaper-inference",
    contextWindow: 128000,
    tools: true,
    vision: false,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "fast-secondary",
    registryId: "fw:accounts/fireworks/models/glm-5p3-flash",
    apiModelId: "accounts/fireworks/models/glm-5p3-flash",
    provider: "fireworks",
    contextWindow: 1_040_000,
    tools: true,
    vision: true,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "auto",
    registryId: "fw:accounts/fireworks/models/deepseek-v4p1-flash",
    apiModelId: "accounts/fireworks/models/deepseek-v4p1-flash",
    provider: "fireworks",
    contextWindow: 1_040_000,
    tools: true,
    vision: true,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "engineering",
    registryId: "fw:accounts/fireworks/models/glm-5p3",
    apiModelId: "accounts/fireworks/models/glm-5p3",
    provider: "fireworks",
    contextWindow: 1_000_000,
    tools: true,
    vision: false,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "frontend",
    registryId: "fw:accounts/fireworks/models/kimi-k2p7-code",
    apiModelId: "accounts/fireworks/models/kimi-k2p7-code",
    provider: "fireworks",
    contextWindow: 262_000,
    tools: true,
    vision: true,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "premium",
    registryId: "ci:gpt-5.6-sol",
    apiModelId: "gpt-5.6-sol",
    provider: "cheaper-inference",
    contextWindow: 128000,
    tools: true,
    vision: true,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "premium-alt",
    registryId: "ci:claude-sonnet-5",
    apiModelId: "claude-sonnet-5",
    provider: "cheaper-inference",
    contextWindow: 200000,
    tools: true,
    vision: true,
    agent: true,
    image: false,
    imageEditing: false,
  },
  {
    lane: "image",
    registryId: "fw:accounts/fireworks/models/flux-kontext-pro",
    apiModelId: "accounts/fireworks/models/flux-kontext-pro",
    provider: "fireworks",
    contextWindow: 4096,
    tools: false,
    vision: false,
    agent: false,
    image: true,
    imageEditing: true,
  },
  {
    lane: "image-quality",
    registryId: "fw:accounts/fireworks/models/flux-kontext-max",
    apiModelId: "accounts/fireworks/models/flux-kontext-max",
    provider: "fireworks",
    contextWindow: 4096,
    tools: false,
    vision: false,
    agent: false,
    image: true,
    imageEditing: true,
  },
];

export function laneModel(lane: LaneModel["lane"]): LaneModel {
  const found = CERTIFIED_MODELS.find((m) => m.lane === lane);
  if (!found) throw new Error(`Unknown lane ${lane}`);
  return found;
}

export function certifiedById(registryId: string): LaneModel | undefined {
  return CERTIFIED_MODELS.find((m) => m.registryId === registryId);
}
