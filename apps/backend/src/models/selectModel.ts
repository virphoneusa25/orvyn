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
  const frontend = input.intent.requiresFrontend && !engineering;

  let lanes: LaneModel["lane"][];
  let reason: string;
  if (laneRequest === "premium" || escalate >= 2) {
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

export function selectImageModel(input: {
  quality?: string;
  editing?: boolean;
  requestedModelId?: string;
  availableIds: string[];
}): { registryId: string | null; reason: string } {
  const available = new Set(input.availableIds);
  const requested = input.requestedModelId?.trim();
  if (requested && requested !== "auto") {
    const known = CERTIFIED_MODELS.find((m) => m.registryId === requested);
    if (input.editing && known && !known.imageEditing) {
      return { registryId: null, reason: `${requested} cannot edit images.` };
    }
    if (available.has(requested)) return { registryId: requested, reason: "User selected this image model." };
    return { registryId: null, reason: `${requested} is not registered.` };
  }
  const lane = input.quality === "high" || input.quality === "premium" ? "image-quality" : "image";
  const primary = laneModel(lane);
  const alt = laneModel(lane === "image" ? "image-quality" : "image");
  for (const model of [primary, alt]) {
    if (!available.has(model.registryId)) continue;
    if (input.editing && !model.imageEditing) continue;
    return { registryId: model.registryId, reason: model.lane === "image-quality" ? "Premium image lane." : "Default image lane." };
  }
  return { registryId: null, reason: "No certified image model is registered." };
}
