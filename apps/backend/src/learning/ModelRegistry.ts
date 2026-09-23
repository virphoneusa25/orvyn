import { randomUUID } from "crypto";
import type { LocalStore } from "../persistence/LocalStore";

export type ModelStatus = "candidate" | "staging" | "production" | "rejected";

export interface RegisteredModel {
  id: string;
  version: string;
  datasetVersion?: string;
  benchmark?: { name: string; score: number };
  createdAt: number;
  status: ModelStatus;
}

export class ModelRegistry {
  constructor(private store: LocalStore) {}

  register(input: { version: string; datasetVersion?: string; benchmark?: { name: string; score: number } }): RegisteredModel {
    const row: RegisteredModel = {
      id: `mdl_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      version: input.version,
      datasetVersion: input.datasetVersion,
      benchmark: input.benchmark,
      createdAt: Date.now(),
      status: "candidate",
    };
    this.store.saveLearningRecord({ id: row.id, kind: "model", payload: row });
    return row;
  }

  list(): RegisteredModel[] {
    return this.store.listLearningRecords("model", 40).map((r) => r.payload as RegisteredModel);
  }

  setStatus(id: string, status: ModelStatus): RegisteredModel | null {
    if (status === "production") {
      throw new Error("Refusing to auto-promote a model to production. Promote only after human review.");
    }
    const rows = this.store.listLearningRecords("model", 80);
    const hit = rows.find((r) => r.id === id);
    if (!hit) return null;
    const next = { ...(hit.payload as RegisteredModel), status };
    this.store.saveLearningRecord({ id, kind: "model", payload: next });
    return next;
  }
}
