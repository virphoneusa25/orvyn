// apps/backend/src/models/modelEquivalents.ts
//
// The same open model is often served by more than one provider (GLM-5.3 on
// Fireworks and Nebius, Kimi K2.7 Code on Fireworks and Nebius). When one
// provider fails for a provider reason (rate limit, outage, timeout), ORVYN
// runs the SAME model on another provider first, so the answer does not
// change character mid-run; only when no provider serves that model does the
// run move to an equivalent model of the same tier.

import { isRouteBlocked } from "./modelAvailability";

/** One open model, by the registry ids that serve it (in order of preference). */
export const SAME_MODEL: { key: string; ids: string[] }[] = [
  { key: "glm-5.3", ids: ["fw:accounts/fireworks/models/glm-5p3", "nebius:zai-org/GLM-5.3", "mistral:zai-glm-5-3"] },
  { key: "glm-5.3-flash", ids: ["fw:accounts/fireworks/models/glm-5p3-flash", "nebius:zai-org/GLM-5.3-Flash"] },
  { key: "kimi-k2.7-code", ids: ["fw:accounts/fireworks/models/kimi-k2p7-code", "nebius:moonshotai/Kimi-K2.7-Code"] },
];

/**
 * Nebius Token Factory models ORVYN uses by role. These are registered and
 * shown in the model menu; the rest of the account's catalog is registered as
 * "more models" (reachable by search, never flooding the menu).
 */
export const NEBIUS_CURATED: { id: string; role: string; context: number; temperature: number }[] = [
  { id: "zai-org/GLM-5.3", role: "Heavy engineering, repairs, long agent runs", context: 131072, temperature: 0.2 },
  { id: "zai-org/GLM-5.3-Flash", role: "Fast chat, titles, summaries, routing", context: 131072, temperature: 0.3 },
  { id: "moonshotai/Kimi-K2.7-Code", role: "Coding agent", context: 131072, temperature: 0.2 },
  { id: "moonshotai/Kimi-K3", role: "Long-horizon agents, advanced reasoning", context: 131072, temperature: 0.3 },
  { id: "Qwen/Qwen3.5-397B-A17B", role: "Research, long documents, general agent work", context: 131072, temperature: 0.3 },
  { id: "Qwen/Qwen3-30B-A3B-Instruct-2507", role: "Cheap helper: small edits, extraction, classification", context: 131072, temperature: 0.2 },
  { id: "deepseek-ai/DeepSeek-V4-Pro", role: "Deep reasoning and debugging", context: 131072, temperature: 0.2 },
  { id: "nvidia/Nemotron-3_5-Lightning", role: "Low-latency utility work", context: 131072, temperature: 0.3 },
];

/** Memory and code-search embeddings on Nebius (opt in with ORVYN_EMBED_MODEL). */
export const NEBIUS_EMBED_MODEL = "Qwen/Qwen3-Embedding-8B";
export const NEBIUS_EMBED_DIMS = 4096;

/** Other registered ids that serve the same model, usable now, in preference order. */
export function sameModelElsewhere(registryId: string, registered: (id: string) => boolean): string[] {
  const group = SAME_MODEL.find((g) => g.ids.includes(registryId));
  if (!group) return [];
  return group.ids.filter((id) => id !== registryId && registered(id) && !isRouteBlocked(id));
}
