// Picks a certified model for a task. A pinned id is never replaced.
// A model that is not registered is skipped; the caller keeps its previous route.

import type { TaskIntent } from "../agent/taskIntent";
import { CERTIFIED_MODELS, laneModel, type LaneModel } from "./certifiedModels";

export type ModelLaneRequest = "auto" | "fast" | "code" | "premium";

export interface ModelHealth {
  registryId: string;
  failureRate: number;
}

export interface AgentModelChoice {
  registryId: string | null;
  lane: LaneModel["lane"] | "pinned";
  reason: string;
  pinned: boolean;
}

const LONG_HORIZON = /\b(architect|refactor|long[- ]horizon|multi-file|across the (repo|codebase))\b/i;

function usable(id: string, available: Set<string>, health: ModelHealth[]): boolean {
  if (!available.has(id)) return false;
  const row = health.find((h) => h.registryId === id);
  return !row || row.failureRate < 0.5;
}

function firstUsable(lanes: LaneModel["lane"][], available: Set<string>, health: ModelHealth[]): LaneModel | undefined {
  for (const lane of lanes) {
    const model = laneModel(lane);
    if (usable(model.registryId, available, health)) return model;
  }
  return undefined;
}

export function selectAgentModel(input: {
  intent: Pick<TaskIntent, "category" | "informational" | "requiresFrontend" | "goal">;
  composerMode?: string;
  requestedModelId?: string;
  availableIds: string[];
  health?: ModelHealth[];
  /** 0 = no escalation. 1 moves Auto to GLM-5.3. 2 moves that to GPT-5.6 Sol. */
  escalate?: number;
}): AgentModelChoice {
  const available = new Set(input.availableIds);
  const health = input.health ?? [];
  const requested = (input.requestedModelId ?? "auto").trim();
  const laneRequest: ModelLaneRequest =
    requested === "fast" || requested === "code" || requested === "premium" ? requested : "auto";
  const pinned = Boolean(requested && requested !== "auto" && laneRequest === "auto");
  if (pinned) {
    return { registryId: requested, lane: "pinned", reason: "User pinned this model.", pinned: true };
  }

  const mode = (input.composerMode ?? "").toLowerCase();
  const escalate = Math.min(Math.max(input.escalate ?? 0, 0), 2);
  const engineering =
    laneRequest === "code" ||
    mode === "code" ||
    mode === "server" ||
    mode === "deploy" ||
    input.intent.category === "server" ||
    input.intent.category === "deploy" ||
    LONG_HORIZON.test(input.intent.goal);
  const frontend = input.intent.requiresFrontend && mode !== "server" && mode !== "deploy" && input.intent.category !== "server";

  let lanes: LaneModel["lane"][];
  let reason: string;
  if (frontend) {
    lanes = (["frontend", "engineering", "premium"] as LaneModel["lane"][]).slice(escalate);
    reason = escalate === 0
      ? "Website builds start with Kimi K2.7 Code, then GLM-5.3, then GPT-5.6 Sol."
      : escalate === 1
        ? "Website repair escalated from Kimi K2.7 Code to GLM-5.3."
        : "Website repair escalated to GPT-5.6 Sol.";
  } else if (laneRequest === "premium" || escalate >= 2) {
    lanes = ["premium", "premium-alt"];
    reason = escalate >= 2 ? "Escalated to the premium lane." : "Premium lane.";
  } else if (frontend) {
    lanes = escalate >= 1 ? ["engineering", "premium"] : ["frontend", "engineering", "premium"];
    reason = "Frontend work uses the website specialist.";
  } else if (engineering || escalate >= 1) {
    lanes = escalate >= 1 && !engineering ? ["engineering", "premium"] : ["engineering", "auto", "premium"];
    reason = "Complex or long-horizon engineering uses GLM-5.3.";
  } else if (laneRequest === "fast" || input.intent.informational) {
    lanes = ["fast", "fast-secondary"];
    reason = "Fast internal lane. Not used for difficult autonomous coding.";
  } else {
    lanes = ["auto", "engineering"];
    reason = "Auto uses DeepSeek V4.1 Flash for routine agent work.";
  }

  const picked = firstUsable(lanes, available, health);
  return {
    registryId: picked?.registryId ?? null,
    lane: picked?.lane ?? lanes[0],
    reason: picked ? reason : "No certified model for this lane is registered.",
    pinned: false,
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
