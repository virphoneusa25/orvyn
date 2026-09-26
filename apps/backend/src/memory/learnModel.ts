// The model that extracts memories: the fast lane when registered, else the chat route.
import type { ModelService } from "../services/ModelService";
import { laneModel } from "../models/certifiedModels";
import type { GenerateLike } from "./userMemory";

export function memoryModel(modelService: ModelService): GenerateLike | undefined {
  for (const lane of ["fast", "fast-secondary", "auto"] as const) {
    const p = modelService.registry.get(laneModel(lane).registryId);
    if (p) return p as unknown as GenerateLike;
  }
  try { return modelService.router.resolve("chat") as unknown as GenerateLike; } catch { return undefined; }
}
