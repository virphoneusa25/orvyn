// apps/backend/src/persistence/PostgresBackfill.ts
//
// Phase B migration tooling: backfill SQLite tenant snapshots into the
// PostgreSQL shadow schema, then compare record counts.
//
// This tool is safe to run repeatedly because all shadow writes are idempotent
// upserts / INSERT ... ON CONFLICT DO NOTHING.

import { Pool } from "pg";
import { createHash } from "crypto";
import { defaultDataDir } from "./LocalStore";
import { PostgresShadowStore } from "./PostgresShadowStore";
import {
  listSQLiteTenantIds,
  readSQLiteTenantSnapshot,
  type TenantSnapshot,
} from "./SQLiteSnapshot";

export interface TenantParity {
  tenantId: string;
  sqlite: {
    missions: number;
    usage: number;
    settings: number;
    models: number;
  };
  postgres: {
    missions: number;
    usage: number;
    settings: number;
    models: number;
  };
  content: {
    missions: boolean;
    usage: boolean;
    settings: boolean;
    models: boolean;
  };
  fingerprints: {
    sqlite: {
      missions: string;
      usage: string;
      settings: string;
      models: string;
    };
    postgres: {
      missions: string;
      usage: string;
      settings: string;
      models: string;
    };
  };
  matches: boolean;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

function normalizeMission(m: any) {
  return {
    id: String(m.id),
    runId: String(m.runId),
    projectRoot: String(m.projectRoot),
    goal: String(m.goal),
    status: String(m.status),
    reviewCycles: Number(m.reviewCycles),
    createdAt: Number(m.createdAt),
    updatedAt: Number(m.updatedAt),
    tasks: m.tasks ?? [],
  };
}

function normalizeUsage(e: any) {
  return {
    id: String(e.id),
    timestamp: Number(e.timestamp),
    modelId: String(e.modelId),
    provider: String(e.provider),
    method: String(e.method),
    durationMs: Number(e.durationMs),
    ok: Boolean(e.ok),
    error: e.error ?? null,
    promptTokens: e.promptTokens ?? null,
    completionTokens: e.completionTokens ?? null,
    outputChars: e.outputChars ?? null,
    toolCalls: e.toolCalls ?? null,
    missionId: e.missionId ?? null,
    taskId: e.taskId ?? null,
    agent: e.agent ?? null,
    source: e.source ?? null,
  };
}

function normalizedSQLite(snapshot: TenantSnapshot) {
  return {
    missions: snapshot.missions
      .map(normalizeMission)
      .sort((a, b) => a.id.localeCompare(b.id)),
    usage: snapshot.usage
      .map(normalizeUsage)
      .sort((a, b) => a.id.localeCompare(b.id)),
    settings: snapshot.settings
      .map((s) => ({ key: String(s.key), value: String(s.value) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    models: snapshot.models
      .map((model) => canonical(model))
      .sort((a: any, b: any) => String(a?.id ?? "").localeCompare(String(b?.id ?? ""))),
  };
}

export async function backfillTenant(
  shadow: PostgresShadowStore,
  snapshot: TenantSnapshot
): Promise<void> {
  for (const mission of snapshot.missions) {
    shadow.mirrorMission(snapshot.tenantId, mission);
  }
  for (const event of snapshot.usage) {
    shadow.mirrorUsageEvent(snapshot.tenantId, event);
  }
  for (const setting of snapshot.settings) {
    shadow.mirrorSetting(snapshot.tenantId, setting.key, setting.value);
  }
  for (const model of snapshot.models) {
    shadow.mirrorModel(snapshot.tenantId, model);
  }
  await shadow.flush();
}

export async function compareTenantParity(
  pool: Pool,
  snapshot: TenantSnapshot
): Promise<TenantParity> {
  const tenantId = snapshot.tenantId;
  const [missionsResult, usageResult, settingsResult, modelsResult] = await Promise.all([
    pool.query(
      `SELECT id, run_id, project_root, goal, status, review_cycles,
              created_at, updated_at, tasks_json
         FROM orvyn_missions
        WHERE tenant_id=$1
        ORDER BY id`,
      [tenantId]
    ),
    pool.query(
      `SELECT id, ts, model_id, provider, method, duration_ms, ok, error,
              prompt_tokens, completion_tokens, output_chars, tool_calls,
              mission_id, task_id, agent, source
         FROM orvyn_usage_events
        WHERE tenant_id=$1
        ORDER BY id`,
      [tenantId]
    ),
    pool.query(
      `SELECT key, value
         FROM orvyn_settings
        WHERE tenant_id=$1
        ORDER BY key`,
      [tenantId]
    ),
    pool.query(
      `SELECT id, config_json
         FROM orvyn_models
        WHERE tenant_id=$1
        ORDER BY id`,
      [tenantId]
    ),
  ]);

  const sqlite = {
    missions: snapshot.missions.length,
    usage: snapshot.usage.length,
    settings: snapshot.settings.length,
    models: snapshot.models.length,
  };
  const postgres = {
    missions: missionsResult.rows.length,
    usage: usageResult.rows.length,
    settings: settingsResult.rows.length,
    models: modelsResult.rows.length,
  };

  const sqliteData = normalizedSQLite(snapshot);
  const postgresData = {
    missions: missionsResult.rows.map((r: any) =>
      normalizeMission({
        id: r.id,
        runId: r.run_id,
        projectRoot: r.project_root,
        goal: r.goal,
        status: r.status,
        reviewCycles: r.review_cycles,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        tasks: r.tasks_json,
      })
    ),
    usage: usageResult.rows.map((r: any) =>
      normalizeUsage({
        id: r.id,
        timestamp: r.ts,
        modelId: r.model_id,
        provider: r.provider,
        method: r.method,
        durationMs: r.duration_ms,
        ok: r.ok,
        error: r.error,
        promptTokens: r.prompt_tokens == null ? null : Number(r.prompt_tokens),
        completionTokens: r.completion_tokens == null ? null : Number(r.completion_tokens),
        outputChars: r.output_chars == null ? null : Number(r.output_chars),
        toolCalls: r.tool_calls == null ? null : Number(r.tool_calls),
        missionId: r.mission_id,
        taskId: r.task_id,
        agent: r.agent,
        source: r.source,
      })
    ),
    settings: settingsResult.rows.map((r: any) => ({
      key: String(r.key),
      value: String(r.value),
    })),
    models: modelsResult.rows.map((r: any) => canonical(r.config_json)),
  };

  const fingerprints = {
    sqlite: {
      missions: fingerprint(sqliteData.missions),
      usage: fingerprint(sqliteData.usage),
      settings: fingerprint(sqliteData.settings),
      models: fingerprint(sqliteData.models),
    },
    postgres: {
      missions: fingerprint(postgresData.missions),
      usage: fingerprint(postgresData.usage),
      settings: fingerprint(postgresData.settings),
      models: fingerprint(postgresData.models),
    },
  };

  const content = {
    missions: fingerprints.sqlite.missions === fingerprints.postgres.missions,
    usage: fingerprints.sqlite.usage === fingerprints.postgres.usage,
    settings: fingerprints.sqlite.settings === fingerprints.postgres.settings,
    models: fingerprints.sqlite.models === fingerprints.postgres.models,
  };

  return {
    tenantId,
    sqlite,
    postgres,
    content,
    fingerprints,
    matches:
      sqlite.missions === postgres.missions &&
      sqlite.usage === postgres.usage &&
      sqlite.settings === postgres.settings &&
      sqlite.models === postgres.models &&
      content.missions &&
      content.usage &&
      content.settings &&
      content.models,
  };
}

export async function backfillAllTenants(options: {
  connectionString: string;
  dataDir?: string;
}): Promise<TenantParity[]> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const tenantIds = listSQLiteTenantIds(dataDir);
  const shadow = new PostgresShadowStore(options.connectionString);
  const pool = new Pool({ connectionString: options.connectionString });

  try {
    if (!(await shadow.ping())) {
      throw new Error("PostgreSQL shadow database is unavailable");
    }

    const results: TenantParity[] = [];
    for (const tenantId of tenantIds) {
      const snapshot = readSQLiteTenantSnapshot(tenantId, dataDir);
      await backfillTenant(shadow, snapshot);
      results.push(await compareTenantParity(pool, snapshot));
    }
    return results;
  } finally {
    await shadow.close();
    await pool.end();
  }
}


/**
 * Read-only parity check. Unlike backfillAllTenants(), this never writes to
 * PostgreSQL; use it immediately before authoritative cutover.
 */
export async function verifyAllTenants(options: {
  connectionString: string;
  dataDir?: string;
}): Promise<TenantParity[]> {
  const dataDir = options.dataDir ?? defaultDataDir();
  const tenantIds = listSQLiteTenantIds(dataDir);
  const pool = new Pool({ connectionString: options.connectionString });

  try {
    const results: TenantParity[] = [];
    for (const tenantId of tenantIds) {
      const snapshot = readSQLiteTenantSnapshot(tenantId, dataDir);
      results.push(await compareTenantParity(pool, snapshot));
    }
    return results;
  } finally {
    await pool.end();
  }
}
