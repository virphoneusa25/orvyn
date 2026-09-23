import type { AIModelProvider, ModelRegistry } from "@orvyn/ai-core";
import { describeModelComputerUse } from "./modelFallback";
import { resolveRuntimeCapabilities } from "./modelComputerCapabilities";

/**
 * Runtime matrix from *configured* models — not provider marketing labels.
 * Native provider computer-use is never required for ORVYN Desktop.
 */
export function configuredComputerUseMatrix(registry: ModelRegistry): Array<{
  id: string;
  provider: string;
  code: boolean;
  tools: boolean;
  vision: boolean;
  computerUse: "available" | "restricted";
  nativeComputerUse: boolean;
  computerUseViaTools: boolean;
}> {
  return registry.list().map((p) => {
    const caps = resolveRuntimeCapabilities(p.config);
    const row = describeModelComputerUse(p);
    return { ...row, nativeComputerUse: caps.nativeComputerUse, computerUseViaTools: caps.computerUseViaTools };
  });
}

export function providerHint(provider: string): {
  toolCalling: boolean;
  vision: boolean | "depends";
  computerUseViaTools: boolean | "policy-dependent";
  nativeComputerUse: false;
} {
  const p = provider.toLowerCase();
  if (p.includes("anthropic") || p.includes("claude")) {
    return { toolCalling: true, vision: true, computerUseViaTools: "policy-dependent", nativeComputerUse: false };
  }
  if (p.includes("glm") || p.includes("zhipu")) {
    return { toolCalling: true, vision: "depends", computerUseViaTools: true, nativeComputerUse: false };
  }
  if (p.includes("openai") || p.includes("gpt") || p.includes("google") || p.includes("gemini")) {
    return { toolCalling: true, vision: true, computerUseViaTools: true, nativeComputerUse: false };
  }
  return { toolCalling: true, vision: "depends", computerUseViaTools: true, nativeComputerUse: false };
}

export function auditComputerUse(input: {
  provider: string;
  model: string;
  capability: string;
  blocked?: boolean;
  fallbackModel?: string;
  tool?: string;
}): Record<string, unknown> {
  return {
    provider: input.provider,
    model: input.model,
    capabilityRequested: input.capability,
    providerBlock: Boolean(input.blocked),
    fallbackModel: input.fallbackModel,
    computerUseTool: input.tool,
  };
}

export function stripProviderSecrets(provider: AIModelProvider): { id: string; provider: string; name: string } {
  return { id: provider.config.id, provider: provider.config.provider, name: provider.config.name };
}
