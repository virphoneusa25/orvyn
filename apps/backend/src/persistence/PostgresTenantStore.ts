// apps/backend/src/persistence/PostgresTenantStore.ts
//
// PostgreSQL-authoritative tenant persistence.
//
// Unlike PostgresShadowStore, every method here returns a Promise and callers
// are expected to await durable writes. One process-level Pool is shared per
// connection string so a multi-tenant API does not create one pool per tenant.

import { Pool } from "pg";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import type { TenantStore } from "./TenantStore";
import { ensurePostgresTenantSchema } from "./PostgresSchema";

interface SharedPool {
  pool: Pool;
  init: Promise<void>;
}

const pools = new Map<string, SharedPool>();

function sharedPool(connectionString: string): SharedPool {
  let shared = pools.get(connectionString);
  if (shared) return shared;

  const pool = new Pool({
    connectionString,
    max: Math.max(1, Number(process.env.ORVYN_POSTGRES_POOL_MAX) || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    application_name: "orvyn-backend-primary",
  });
  shared = {
    pool,
    init: ensurePostgresTenantSchema(pool),
  };
  pools.set(connectionString, shared);
  return shared;
}

export async function closePostgresTenantPools(): Promise<void> {
  const active = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(active.map((entry) => entry.pool.end()));
}

function rowToMission(r: any): Mission {
  return {
    id: String(r.id),
    runId: String(r.run_id),
    projectRoot: String(r.project_root),
    goal: String(r.goal),
    status: r.status,
    reviewCycles: Number(r.review_cycles),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    tasks: Array.isArray(r.tasks_json) ? r.tasks_json : [],
  };
}

function rowToUsage(r: any): UsageEvent {
  const event: UsageEvent = {
    id: String(r.id),
    timestamp: Number(r.ts),
    modelId: String(r.model_id),
    provider: String(r.provider),
    method: r.method,
    durationMs: Number(r.duration_ms),
    ok: Boolean(r.ok),
  };
  if (r.error != null) event.error = String(r.error);
  if (r.prompt_tokens != null) event.promptTokens = Number(r.prompt_tokens);
  if (r.completion_tokens != null) event.completionTokens = Number(r.completion_tokens);
  if (r.output_chars != null) event.outputChars = Number(r.output_chars);
  if (r.tool_calls != null) event.toolCalls = Number(r.tool_calls);
  if (r.mission_id != null) event.missionId = String(r.mission_id);
  if (r.task_id != null) event.taskId = String(r.task_id);
  if (r.agent != null) event.agent = String(r.agent);
  if (r.source != null) event.source = String(r.source);
  return event;
}

export class PostgresTenantStore implements TenantStore {
  readonly driver = "postgres" as const;
  private readonly shared: SharedPool;

  constructor(
    public readonly tenantId: string,
    connectionString: string
  ) {
    this.shared = sharedPool(connectionString);
  }

  async initialize(): Promise<void> {
    await this.shared.init;
  }

  async health(): Promise<boolean> {
    try {
      await this.shared.pool.query("SELECT 1");
      return true;
    } catch {
      return false;
    }
  }

  async saveMission(m: Mission): Promise<void> {
    await this.shared.pool.query(
      `INSERT INTO orvyn_missions
        (tenant_id, id, run_id, project_root, goal, status, review_cycles, created_at, updated_at, tasks_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         project_root = EXCLUDED.project_root,
         goal = EXCLUDED.goal,
         status = EXCLUDED.status,
         review_cycles = EXCLUDED.review_cycles,
         created_at = EXCLUDED.created_at,
         updated_at = EXCLUDED.updated_at,
         tasks_json = EXCLUDED.tasks_json`,
      [
        this.tenantId,
        m.id,
        m.runId,
        m.projectRoot,
        m.goal,
        m.status,
        m.reviewCycles,
        m.createdAt,
        m.updatedAt,
        JSON.stringify(m.tasks),
      ]
    );
  }

  async loadMissions(limit = 200): Promise<Mission[]> {
    const result = await this.shared.pool.query(
      `SELECT id, run_id, project_root, goal, status, review_cycles,
              created_at, updated_at, tasks_json
         FROM orvyn_missions
        WHERE tenant_id=$1
        ORDER BY created_at DESC
        LIMIT $2`,
      [this.tenantId, limit]
    );
    return result.rows.map(rowToMission);
  }

  async saveUsageEvent(e: UsageEvent): Promise<void> {
    await this.shared.pool.query(
      `INSERT INTO orvyn_usage_events
        (tenant_id, id, ts, model_id, provider, method, duration_ms, ok, error,
         prompt_tokens, completion_tokens, output_chars, tool_calls, mission_id,
         task_id, agent, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (tenant_id, id) DO NOTHING`,
      [
        this.tenantId,
        e.id,
        e.timestamp,
        e.modelId,
        e.provider,
        e.method,
        e.durationMs,
        e.ok,
        e.error ?? null,
        e.promptTokens ?? null,
        e.completionTokens ?? null,
        e.outputChars ?? null,
        e.toolCalls ?? null,
        e.missionId ?? null,
        e.taskId ?? null,
        e.agent ?? null,
        e.source ?? null,
      ]
    );
  }

  async countUsageSince(ts: number): Promise<number> {
    const result = await this.shared.pool.query(
      `SELECT COUNT(*)::int AS n
         FROM orvyn_usage_events
        WHERE tenant_id=$1 AND ts >= $2`,
      [this.tenantId, ts]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async countMissionsSince(ts: number): Promise<number> {
    const result = await this.shared.pool.query(
      `SELECT COUNT(*)::int AS n
         FROM orvyn_missions
        WHERE tenant_id=$1 AND created_at >= $2`,
      [this.tenantId, ts]
    );
    return Number(result.rows[0]?.n ?? 0);
  }

  async loadRecentUsage(limit = 5000): Promise<UsageEvent[]> {
    const result = await this.shared.pool.query(
      `SELECT id, ts, model_id, provider, method, duration_ms, ok, error,
              prompt_tokens, completion_tokens, output_chars, tool_calls,
              mission_id, task_id, agent, source
         FROM orvyn_usage_events
        WHERE tenant_id=$1
        ORDER BY ts DESC
        LIMIT $2`,
      [this.tenantId, limit]
    );
    return result.rows.reverse().map(rowToUsage);
  }

  async getSetting(key: string): Promise<string | null> {
    const result = await this.shared.pool.query(
      `SELECT value
         FROM orvyn_settings
        WHERE tenant_id=$1 AND key=$2`,
      [this.tenantId, key]
    );
    return result.rows[0] ? String(result.rows[0].value) : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.shared.pool.query(
      `INSERT INTO orvyn_settings (tenant_id, key, value, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (tenant_id, key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [this.tenantId, key, value]
    );
  }

  async getToolOverrides(projectRoot: string): Promise<Record<string, string>> {
    const raw = await this.getSetting(`toolOverrides:${projectRoot}`);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  async setToolOverride(
    projectRoot: string,
    tool: string,
    permission: string
  ): Promise<void> {
    const current = await this.getToolOverrides(projectRoot);
    current[tool] = permission;
    await this.setSetting(
      `toolOverrides:${projectRoot}`,
      JSON.stringify(current)
    );
  }

  async saveModel(config: ModelConfig): Promise<void> {
    await this.shared.pool.query(
      `INSERT INTO orvyn_models (tenant_id, id, config_json, updated_at)
       VALUES ($1,$2,$3::jsonb,NOW())
       ON CONFLICT (tenant_id, id) DO UPDATE SET
         config_json = EXCLUDED.config_json,
         updated_at = NOW()`,
      [this.tenantId, config.id, JSON.stringify(config)]
    );
  }

  async deleteModel(id: string): Promise<void> {
    await this.shared.pool.query(
      `DELETE FROM orvyn_models WHERE tenant_id=$1 AND id=$2`,
      [this.tenantId, id]
    );
  }

  async loadModels(): Promise<ModelConfig[]> {
    const result = await this.shared.pool.query(
      `SELECT config_json
         FROM orvyn_models
        WHERE tenant_id=$1
        ORDER BY id`,
      [this.tenantId]
    );
    return result.rows.map((r) => r.config_json as ModelConfig);
  }

  async close(): Promise<void> {
    // Pool is process-shared; lifecycle is owned by closePostgresTenantPools().
  }
}
