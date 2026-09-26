// Picks a certified model for a task. A pinned id is never replaced.
// A model that is not registered is skipped; the caller keeps its previous route.

import type { TaskIntent } from "../agent/taskIntent";
import { CERTIFIED_MODELS, laneModel, type LaneModel } from "./certifiedModels";
import { escalate, LADDERS, profileFor, startRoute, stepFrom, TIERS, type RouteProfile, type RouteStep, type Tier } from "./routingPolicy";

export type ModelLaneRequest = "auto" | "fast" | "code" | "premium";

export interface ModelHealth {
  registryId: string;
  failureRate: number;
}

export interface AgentModelChoice {
  registryId: string | null;
  /** The routing tier that serves the run ("code", "advanced", "heavy"…), or "pinned". */
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
}): AgentModelChoice {
  const requested = (input.requestedModelId ?? "auto").trim();
  const laneRequest: ModelLaneRequest =
    requested === "fast" || requested === "code" || requested === "premium" ? requested : "auto";
  const pinned = Boolean(requested && requested !== "auto" && laneRequest === "auto");
  if (pinned) {
    return { registryId: requested, lane: "pinned", reason: "User pinned this model.", pinned: true };
  }
  const health = input.health ?? [];
  const mode = (input.composerMode ?? "").toLowerCase();
  let profile: RouteProfile = input.intent.requiresFrontend && mode !== "server" && mode !== "deploy"
    ? "code"
    : profileFor({ composerMode: laneRequest === "code" ? "code" : mode, category: input.intent.category, instruction: input.intent.goal ?? "", deep: input.deep });
  let route = startRoute({ profile, instruction: input.intent.goal ?? "", availableIds: input.availableIds, health });
  if (laneRequest === "premium") {
    // The user asked for the strongest model: Ultra first, Deep behind it.
    const tiers: Tier[] = ["ultra", "deep", "heavy"];
    const hit = stepFrom(tiers, 0, input.availableIds, health);
    route = { profile, tiers, step: hit?.step ?? 0, tier: hit?.tier ?? "ultra", registryId: hit?.registryId ?? null, weight: TIERS[hit?.tier ?? "ultra"].weight, reason: "Premium lane (requested)." };
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
  const premium = input.quality === "high" || input.quality === "premium";
  const lanes: LaneModel["lane"][] = premium ? ["image-quality", "image"] : ["image", "image-quality"];
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
    if (!available.has(row.registryId) || !row.generation) continue;
    if (input.editing && !row.editing) continue;
    return { registryId: row.registryId, reason: "Cheaper Inference image lane from the live catalog." };
  }
  return { registryId: null, reason: input.editing ? "No registered model can edit images." : "No certified image model is registered." };
}
