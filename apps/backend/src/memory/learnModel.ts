// The model that extracts memories: the fast lane when registered, else the chat route.
import type { ModelService } from "../services/ModelService";
import { laneModel } from "../models/certifiedModels";
import { TIERS } from "../models/routingPolicy";
import type { GenerateLike } from "./userMemory";

export function memoryModel(modelService: ModelService): GenerateLike | undefined {
  // The routing policy's utility tier (Mistral Small 4, then GPT-5.6 Luna, …), then the old fast lanes.
  for (const id of [...TIERS.utility.candidates, ...(["fast", "fast-secondary", "auto"] as const).map((l) => laneModel(l).registryId)]) {
    const p = modelService.registry.get(id);
    if (p) return p as unknown as GenerateLike;
  }
  try { return modelService.router.resolve("chat") as unknown as GenerateLike; } catch { return undefined; }
}
