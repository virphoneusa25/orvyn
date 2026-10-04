// Picks a certified model for a task. A pinned id is never replaced.
// A model that is not registered is skipped; the caller keeps its previous route.

import type { TaskIntent } from "../agent/taskIntent";
import { preferHuggingFace, incompatibility, routeFamily, isRoutineWriting, writingProvider, writingFallbackReason, type AIModelProvider, type RoutingRequirements } from "@orvyn/ai-core";
import { isRouteBlocked } from "./modelAvailability";
import { CERTIFIED_MODELS, laneModel, type LaneModel } from "./certifiedModels";
import { escalate, LADDERS, profileFor, startRoute, stepFrom, TIERS, type RouteProfile, type RouteStep, type Tier } from "./routingPolicy";

export type ModelLaneRequest = "auto" | "fast" | "code" | "premium" | "reasoning" | "research" | "vision";
const LANE_REQUESTS = new Set(["auto", "fast", "code", "premium", "reasoning", "research", "vision"]);

export interface ModelHealth {
  registryId: string;
  failureRate: number;
}

export interface AgentModelChoice {
  registryId: string | null;
  /** The routing tier that serves the run ("code", "server", "heavy"…), or "pinned". */
  lane: Tier | "pinned";
  reason: string;
  pinned: boolean;
  /** The run's routing profile and ladder (absent when pinned). */
  route?: RouteStep;
}

/**
 * Picks the model for an agent run from ORVYN's routing policy
 * (models/routingPolicy.ts): the run's profile (Code, Server, Auto, Deep)
 * decides the ladder; the first registered model on it serves; `escalate`
 * climbs that many steps. A pinned id is never replaced.
 */
export function selectAgentModel(input: {
  intent: Pick<TaskIntent, "category" | "informational" | "requiresFrontend" | "goal">;
  composerMode?: string;
  requestedModelId?: string;
  availableIds: string[];
  health?: ModelHealth[];
  /** Steps up the run's ladder (repairs that did not work). */
  escalate?: number;
  /** A thinking-heavy task (strategy, planning, naming, architecture, deep reasoning). */
  deep?: boolean;
  /** Registered models that understand images (for the Vision lane). */
  visionIds?: string[];
  providers?: AIModelProvider[];
  requirements?: Partial<RoutingRequirements>;
}): AgentModelChoice {
  const requested = (input.requestedModelId ?? "auto").trim() || "auto";
  const laneRequest: ModelLaneRequest = LANE_REQUESTS.has(requested) ? (requested as ModelLaneRequest) : "auto";
  const pinned = Boolean(requested && requested !== "auto" && !LANE_REQUESTS.has(requested));
  if (pinned) {
    return { registryId: requested, lane: "pinned", reason: "User pinned this model.", pinned: true };
  }
  const needs: RoutingRequirements = { capability: "agent", tools: true, streaming: true, ...input.requirements };
  if (input.providers) {
    const eligible = new Set(input.providers.filter((p) => !incompatibility(p.config, needs) && !isRouteBlocked(p.config.id) && (!p.config.id.startsWith("hf:") || /^(1|true|yes|on)$/i.test(process.env.HUGGINGFACE_ROUTING_ENABLED ?? ""))).map((p) => p.config.id));
    input = { ...input, availableIds: input.availableIds.filter((id) => eligible.has(id)) };
  }
  const health = input.health ?? [];
  const mode = (input.composerMode ?? "").toLowerCase();
  let profile: RouteProfile = input.intent.requiresFrontend && mode !== "server" && mode !== "deploy"
    ? "code"
    : profileFor({ composerMode: laneRequest === "code" ? "code" : mode, category: input.intent.category, instruction: input.intent.goal ?? "", deep: input.deep });
  let route = startRoute({ profile, instruction: input.intent.goal ?? "", availableIds: input.availableIds, health });
  if (laneRequest === "reasoning" || laneRequest === "research" || laneRequest === "vision") {
    // ORVYN's named models (customer catalog): a fixed ladder per model.
    const tiers: Tier[] = laneRequest === "reasoning" ? ["deep"] : laneRequest === "research" ? ["research", "deep"] : ["vision", "server", "auto"];
    const pool = laneRequest === "vision" ? (input.visionIds ?? []).filter((id) => input.availableIds.includes(id)) : input.availableIds;
    const hit = stepFrom(tiers, 0, pool, health);
    const fallbackVision = laneRequest === "vision" && !hit ? pool[0] ?? null : null;
    route = { profile, tiers, step: hit?.step ?? 0, tier: hit?.tier ?? tiers[0]!, registryId: hit?.registryId ?? fallbackVision, weight: TIERS[hit?.tier ?? tiers[0]!].weight, reason: `${laneRequest[0]!.toUpperCase()}${laneRequest.slice(1)} (requested).` };
  } else if (laneRequest === "premium") {
    // Premium long-horizon work starts on Kimi K3. Ultra remains a separate,
    // explicitly enabled exceptional escalation and is never selected here.
    const tiers: Tier[] = ["premium", "deep"];
    const hit = stepFrom(tiers, 0, input.availableIds, health);
    route = { profile, tiers, step: hit?.step ?? 0, tier: hit?.tier ?? "premium", registryId: hit?.registryId ?? null, weight: TIERS[hit?.tier ?? "premium"].weight, reason: "Premium lane (requested)." };
  } else if (laneRequest === "fast" || (input.intent.informational && !input.deep && profile !== "server" && !input.intent.requiresFrontend)) {
    // Quick informational work (a question, not a change) starts on the utility tier.
    const tiers: Tier[] = ["utility", ...LADDERS[profile]];
    const hit = stepFrom(tiers, 0, input.availableIds, health);
    route = { profile, tiers, step: hit?.step ?? 0, tier: hit?.tier ?? "utility", registryId: hit?.registryId ?? null, weight: TIERS[hit?.tier ?? "utility"].weight, reason: "Fast utility tier for quick work." };
  }
  const steps = Math.max(0, Math.min(input.escalate ?? 0, route.tiers.length));
  for (let i = 0; i < steps; i++) {
    const next = escalate(route, input.availableIds, health, "Escalated after repairs did not work.");
    if (!next) break;
    route = next;
  }
  if (input.providers && laneRequest === "auto" && steps === 0) {
    const writing = !input.deep && profile === "auto" && isRoutineWriting(input.intent.goal ?? "")
      ? writingProvider(input.providers.filter((p) => input.availableIds.includes(p.config.id)), needs, isRouteBlocked) : undefined;
    if (writing) return { registryId: writing.config.id, lane: "auto", pinned: false,
      reason: "Routine writing: direct DeepSeek Flash passed current pricing and streaming/tool verification", route: { ...route, registryId: writing.config.id } };
    const writingFailure = !input.deep && profile === "auto" && isRoutineWriting(input.intent.goal ?? "") ? writingFallbackReason(input.providers) : "";
    const family = input.intent.informational && !input.deep && !input.intent.requiresFrontend ? "flash" : routeFamily(route.registryId ?? "") ?? (route.tier === "code" ? "code" : route.tier === "agent" || route.tier === "heavy" ? "advanced" : route.tier === "auto" ? "flash" : undefined);
    const preferred = preferHuggingFace(input.providers.filter((p) => input.availableIds.includes(p.config.id)), needs, /^(1|true|yes|on)$/i.test(process.env.HUGGINGFACE_ROUTING_ENABLED ?? ""), isRouteBlocked, family);
    if (preferred.provider) route = { ...route, registryId: preferred.provider.config.id, reason: preferred.reason };
    else route = { ...route, reason: `${route.reason} ${preferred.reason}` };
    if (writingFailure) route = { ...route, reason: `${writingFailure}; ${route.reason}` };
  }
  return {
    registryId: route.registryId,
    lane: route.tier,
    reason: route.registryId ? route.reason : "No model for this profile is registered.",
    pinned: false,
    route,
  };
}

export interface ImageCatalogEntry {
  registryId: string;
  generation: boolean;
  editing: boolean;
}

export function selectImageModel(input: {
  quality?: string;
  editing?: boolean;
  requestedModelId?: string;
  availableIds: string[];
  /** Live provider catalog. Generation does not imply editing. */
  catalog?: ImageCatalogEntry[];
}): { registryId: string | null; reason: string } {
  const available = new Set(input.availableIds);
  const catalog = new Map((input.catalog ?? []).map((row) => [row.registryId, row]));
  const canEdit = (id: string, certifiedEditing: boolean): boolean => {
    const row = catalog.get(id);
    if (row) return row.editing;
    return certifiedEditing;
  };
  const requested = input.requestedModelId?.trim();
  if (requested && requested !== "auto") {
    const known = CERTIFIED_MODELS.find((m) => m.registryId === requested);
    if (input.editing && !canEdit(requested, known?.imageEditing === true)) {
      return { registryId: null, reason: `${requested} cannot edit images.` };
    }
    if (available.has(requested)) return { registryId: requested, reason: "User selected this image model." };
    return { registryId: null, reason: `${requested} is not registered.` };
  }
  const premium = input.quality === "premium";
  const lanes: LaneModel["lane"][] = premium ? ["image-quality", "image"] : ["image"];
  for (const lane of lanes) {
    const model = laneModel(lane);
    if (!available.has(model.registryId)) continue;
    if (input.editing && !canEdit(model.registryId, model.imageEditing)) continue;
    return {
      registryId: model.registryId,
      reason: model.lane === "image-quality" ? "Premium image lane: FLUX.1 Kontext Max." : "Default image lane: FLUX.1 Kontext Pro.",
    };
  }
  const preferred = /gpt-image|nano-banana|grok-imagine/i;
  const rows = [...(input.catalog ?? [])].sort((a, b) => Number(preferred.test(b.registryId)) - Number(preferred.test(a.registryId)));
  for (const row of rows) {
    if (!premium && /flux-kontext-max$/.test(row.registryId)) continue;
    if (!available.has(row.registryId) || !row.generation) continue;
    if (input.editing && !row.editing) continue;
    return { registryId: row.registryId, reason: "Cheaper Inference image lane from the live catalog." };
  }
  return { registryId: null, reason: input.editing ? "No registered model can edit images." : "No certified image model is registered." };
}
