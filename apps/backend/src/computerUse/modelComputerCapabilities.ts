import type { AIModelProvider, ModelConfig } from "@orvyn/ai-core";
import type { RuntimeModelCapabilities } from "./types";

/** ORVYN-owned computer-use. Native provider CU is never required. */
export function resolveRuntimeCapabilities(model: Pick<ModelConfig, "capabilities" | "provider" | "id">): RuntimeModelCapabilities {
  const c = model.capabilities;
  const toolCalling = c.tools === true;
  const vision = c.vision === true;
  const nativeComputerUse = c.nativeComputerUse === true;
  const computerUseViaTools = c.computerUseViaTools !== false && toolCalling;
  return { toolCalling, vision, computerUseViaTools, nativeComputerUse };
}

export function canCallComputerTools(caps: RuntimeModelCapabilities): boolean {
  return caps.computerUseViaTools && caps.toolCalling;
}

export function canInspectScreenshots(caps: RuntimeModelCapabilities): boolean {
  return caps.vision;
}

export function computerUseLabel(caps: RuntimeModelCapabilities): "available" | "restricted" {
  return canCallComputerTools(caps) ? "available" : "restricted";
}

export function isComputerUseCompatible(provider: AIModelProvider): boolean {
  return canCallComputerTools(resolveRuntimeCapabilities(provider.config));
}

export function isVisualComputerCompatible(provider: AIModelProvider): boolean {
  const caps = resolveRuntimeCapabilities(provider.config);
  return canCallComputerTools(caps) && canInspectScreenshots(caps);
}

/** Capability search hit — computer_use is an ORVYN capability, not MCP. */
export function builtinComputerUseHit(query: string): boolean {
  return /\b(computer([ _-]?use)?|desktop|visual qa|click through|screenshot|xdotool)\b/i.test(query);
}
