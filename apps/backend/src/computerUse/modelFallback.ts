import type { AIModelProvider, ModelRegistry } from "@orvyn/ai-core";
import { allowlistAllows, readComputerUsePolicy } from "./modelPolicy";
import { isVisualComputerCompatible, isComputerUseCompatible, resolveRuntimeCapabilities } from "./modelComputerCapabilities";
import { TIERS } from "../models/routingPolicy";

export interface FallbackDecision {
  switched: boolean;
  requestedModel: string;
  actualModel: string;
  fallbackReason?: string;
  fallbackCount: number;
}

const MAX_FALLBACKS = 2;

export function modelFallbackAllowed(auto: boolean, policyDisabled?: boolean): boolean {
  if (policyDisabled) return false;
  if (readComputerUsePolicy().fallbackDisabled) return false;
  return auto;
}

export function pickCompatibleComputerModel(
  registry: ModelRegistry,
  currentId: string,
  opts?: { requireVision?: boolean; allowlist?: string[] }
): AIModelProvider | undefined {
  const requireVision = opts?.requireVision !== false;
  const allow = opts?.allowlist?.length ? new Set(opts.allowlist) : null;
  const match = requireVision ? isVisualComputerCompatible : isComputerUseCompatible;
  const eligible = (p: AIModelProvider) => {
    if (p.config.id === currentId) return false;
    if (allow && !allowlistAllows([...allow], p.config.id, p.config.provider)) return false;
    if (!p.config.capabilities.agent) return false;
    return match(p);
  };
  // Computer use is a visual lane: Qwen/Gemini-class vision models first,
  // then the registry as a compatibility fallback.
  const preferred = [...TIERS.vision.candidates, ...TIERS.server.candidates, ...TIERS.auto.candidates];
  for (const id of preferred) {
    const provider = registry.get(id);
    if (provider && eligible(provider)) return provider;
  }
  return registry.list().find(eligible);
}

export function decideComputerUseFallback(input: {
  auto: boolean;
  pinnedModelId?: string;
  current: AIModelProvider;
  registry: ModelRegistry;
  fallbackCount: number;
  requireVision?: boolean;
  allowlist?: string[];
  policyDisabled?: boolean;
}): { next?: AIModelProvider; decision: FallbackDecision; pinnedBlocked: boolean } {
  const requested = input.pinnedModelId ?? "auto";
  const actual = input.current.config.id;
  if (!modelFallbackAllowed(input.auto, input.policyDisabled)) {
    return {
      pinnedBlocked: Boolean(input.pinnedModelId),
      decision: { switched: false, requestedModel: requested, actualModel: actual, fallbackCount: input.fallbackCount },
    };
  }
  if (input.fallbackCount >= MAX_FALLBACKS) {
    return {
      pinnedBlocked: false,
      decision: {
        switched: false,
        requestedModel: requested,
        actualModel: actual,
        fallbackReason: "fallback limit reached",
        fallbackCount: input.fallbackCount,
      },
    };
  }
  const policy = readComputerUsePolicy();
  const allowlist = input.allowlist?.length ? input.allowlist : policy.allowlist;
  const next = pickCompatibleComputerModel(input.registry, actual, {
    requireVision: input.requireVision,
    allowlist,
  });
  if (!next) {
    return {
      pinnedBlocked: false,
      decision: {
        switched: false,
        requestedModel: requested,
        actualModel: actual,
        fallbackReason: "no compatible model configured",
        fallbackCount: input.fallbackCount,
      },
    };
  }
  return {
    pinnedBlocked: false,
    next,
    decision: {
      switched: true,
      requestedModel: requested,
      actualModel: next.config.id,
      fallbackReason: `${actual} cannot perform computer-use via ORVYN tools; switched to ${next.config.id}`,
      fallbackCount: input.fallbackCount + 1,
    },
  };
}

export function describeModelComputerUse(provider: AIModelProvider): {
  id: string;
  provider: string;
  code: boolean;
  tools: boolean;
  vision: boolean;
  computerUse: "available" | "restricted";
} {
  const caps = resolveRuntimeCapabilities(provider.config);
  return {
    id: provider.config.id,
    provider: provider.config.provider,
    code: provider.config.capabilities.code,
    tools: caps.toolCalling,
    vision: caps.vision,
    computerUse: caps.computerUseViaTools ? "available" : "restricted",
  };
}
