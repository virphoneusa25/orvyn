import type { TenantPersistence as LocalStore } from "../persistence/TenantPersistence";
import type { Experience } from "./ExperienceStore";
import { sanitizeRecord } from "./sanitize";

export interface DatasetCandidate {
  id: string;
  experienceIds: string[];
  createdAt: number;
  status: "candidate";
  reason: string;
}

export function trainingCandidates(experiences: Experience[]): Experience[] {
  return experiences.filter((e) => e.evaluation.eligibleForTraining && e.result === "success" && e.failures.length === 0);
}

export async function persistDataset(store: LocalStore, experiences: Experience[]): Promise<DatasetCandidate | null> {
  const eligible = trainingCandidates(experiences);
  if (eligible.length === 0) return null;
  const row: DatasetCandidate = sanitizeRecord({
    id: "ds_current",
    experienceIds: eligible.map((e) => e.id),
    createdAt: Date.now(),
    status: "candidate",
    reason: `${eligible.length} sanitized successful runs — not auto-promoted`,
  });
  await store.saveLearningRecord({ id: row.id, kind: "dataset", payload: row });
  return row;
}
