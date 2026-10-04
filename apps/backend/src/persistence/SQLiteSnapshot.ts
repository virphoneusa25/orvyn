// apps/backend/src/persistence/SQLiteSnapshot.ts
//
// Read-only migration snapshot helpers for Phase B backfill/parity.
// These deliberately bypass LocalStore shadow hooks so reading/backfilling an
// old SQLite database cannot recursively generate extra mirror writes.

import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import * as path from "path";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";

export interface TenantSnapshot {
  tenantId: string;
  missions: Mission[];
  usage: UsageEvent[];
  settings: Array<{ key: string; value: string }>;
  models: ModelConfig[];
}

export function listSQLiteTenantIds(dataDir: string): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs
    .readdirSync(dataDir)
    .filter((name) => name.endsWith(".db") && name !== "auth.db")
    .map((name) => name.slice(0, -3))
    .sort();
}

export function readSQLiteTenantSnapshot(
  tenantId: string,
  dataDir: string
): TenantSnapshot {
  const dbPath = path.join(dataDir, `${tenantId}.db`);
  if (!fs.existsSync(dbPath)) {
    throw new Error(`SQLite tenant database not found: ${dbPath}`);
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const missions = (db
      .prepare("SELECT * FROM missions ORDER BY created_at ASC")
      .all() as any[]).map((r) => ({
      id: String(r.id),
      runId: String(r.run_id),
      projectRoot: String(r.project_root),
      goal: String(r.goal),
      status: r.status,
      reviewCycles: Number(r.review_cycles),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      tasks: JSON.parse(String(r.tasks_json)),
    })) as Mission[];

    const usage = (db
      .prepare("SELECT * FROM usage_events ORDER BY ts ASC")
      .all() as any[]).map((r) => {
      const e: UsageEvent = {
        id: String(r.id),
        timestamp: Number(r.ts),
        modelId: String(r.model_id),
        provider: String(r.provider),
        method: r.method,
        durationMs: Number(r.duration_ms),
        ok: Number(r.ok) === 1,
      };
      if (r.error != null) e.error = String(r.error);
      if (r.prompt_tokens != null) e.promptTokens = Number(r.prompt_tokens);
      if (r.completion_tokens != null) e.completionTokens = Number(r.completion_tokens);
      if (r.output_chars != null) e.outputChars = Number(r.output_chars);
      if (r.tool_calls != null) e.toolCalls = Number(r.tool_calls);
      if (r.mission_id != null) e.missionId = String(r.mission_id);
      if (r.task_id != null) e.taskId = String(r.task_id);
      if (r.agent != null) e.agent = String(r.agent);
      if (r.source != null) e.source = String(r.source);
      return e;
    });

    const settings = (db
      .prepare("SELECT key, value FROM settings ORDER BY key")
      .all() as any[]).map((r) => ({
      key: String(r.key),
      value: String(r.value),
    }));

    const models = (db
      .prepare("SELECT config_json FROM models ORDER BY id")
      .all() as any[]).map(
      (r) => JSON.parse(String(r.config_json)) as ModelConfig
    );

    return { tenantId, missions, usage, settings, models };
  } finally {
    db.close();
  }
}
