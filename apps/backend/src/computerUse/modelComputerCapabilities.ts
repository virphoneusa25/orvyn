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
  const native = /\b(computer[ _-]?(?:use|screenshot)|desktop|installer window|native application|xdotool)\b/i.test(query);
  if(native)return true;
  if(/\b(website|webpage|landing page|browser|web page)\b/i.test(query))return false;
  return /\b(computer|visual qa|click through|screenshot)\b/i.test(query);
}
