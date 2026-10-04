// apps/backend/src/persistence/PostgresShadowStore.ts
//
// Phase A of the cloud persistence migration.
//
// SQLite remains authoritative while this store mirrors tenant data into
// PostgreSQL. Shadow writes are intentionally non-blocking for the current
// synchronous LocalStore contract, but every pending write is tracked and can
// be flushed/inspected by tests and migration tooling.
//
// This is a migration bridge, not the final persistence interface. Phase C
// will make PostgreSQL authoritative and refactor correctness-critical callers
// to await durable writes explicitly.

import { Pool } from "pg";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import { ensurePostgresTenantSchema } from "./PostgresSchema";

export interface PostgresShadowStatus {
  enabled: boolean;
  ready: boolean;
  pendingWrites: number;
  failures: number;
  lastError?: string;
}

export class PostgresShadowStore {
  private readonly pool: Pool;
  private initPromise: Promise<void> | null = null;
  private readonly pending = new Set<Promise<unknown>>();
  private writeTail: Promise<void> = Promise.resolve();
  private failures = 0;
  private lastError?: string;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Math.max(1, Number(process.env.ORVYN_POSTGRES_POOL_MAX) || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      application_name: "orvyn-backend",
    });
  }

  private async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = ensurePostgresTenantSchema(this.pool);
    }
    return this.initPromise;
  }

  private track(label: string, work: () => Promise<unknown>): void {
    // Preserve call order. Shadow mode receives synchronous LocalStore writes
    // (profile A -> profile B, mission RUNNING -> COMPLETED, etc.). Launching
    // each PostgreSQL query concurrently can let an older write commit after a
    // newer one and leave the shadow database stale.
    let p!: Promise<unknown>;
    p = this.writeTail
      .then(async () => {
        await this.init();
        await work();
      })
      .catch((err: any) => {
        this.failures++;
        this.lastError = `${label}: ${err?.message ?? String(err)}`;
        console.warn(`Postgres shadow write failed (${this.lastError})`);
      })
      .finally(() => this.pending.delete(p));

    // A failed mirror write is recorded above but must never poison the queue
    // and prevent later shadow writes from being attempted.
    this.writeTail = p.then(
      () => undefined,
      () => undefined
    );
    this.pending.add(p);
  }

  mirrorMission(tenantId: string, m: Mission): void {
    this.track("mission", () =>
      this.pool.query(
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
          tenantId,
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
      )
    );
  }

  mirrorUsageEvent(tenantId: string, e: UsageEvent): void {
    this.track("usage", () =>
      this.pool.query(
        `INSERT INTO orvyn_usage_events
          (tenant_id, id, ts, model_id, provider, method, duration_ms, ok, error,
           prompt_tokens, completion_tokens, output_chars, tool_calls, mission_id,
           task_id, agent, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (tenant_id, id) DO NOTHING`,
        [
          tenantId,
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
      )
    );
  }

  mirrorSetting(tenantId: string, key: string, value: string): void {
    this.track("setting", () =>
      this.pool.query(
        `INSERT INTO orvyn_settings (tenant_id, key, value, updated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (tenant_id, key) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = NOW()`,
        [tenantId, key, value]
      )
    );
  }

  mirrorModel(tenantId: string, config: ModelConfig): void {
    this.track("model", () =>
      this.pool.query(
        `INSERT INTO orvyn_models (tenant_id, id, config_json, updated_at)
         VALUES ($1,$2,$3::jsonb,NOW())
         ON CONFLICT (tenant_id, id) DO UPDATE SET
           config_json = EXCLUDED.config_json,
           updated_at = NOW()`,
        [tenantId, config.id, JSON.stringify(config)]
      )
    );
  }

  deleteModel(tenantId: string, id: string): void {
    this.track("delete model", () =>
      this.pool.query(
        `DELETE FROM orvyn_models WHERE tenant_id = $1 AND id = $2`,
        [tenantId, id]
      )
    );
  }

  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.init();
      await this.pool.query("SELECT 1");
      return true;
    } catch (err: any) {
      this.failures++;
      this.lastError = `ping: ${err?.message ?? String(err)}`;
      return false;
    }
  }

  status(): PostgresShadowStatus {
    return {
      enabled: true,
      ready: this.initPromise !== null,
      pendingWrites: this.pending.size,
      failures: this.failures,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }
}

let singleton: PostgresShadowStore | null | undefined;

export function postgresShadowEnabled(): boolean {
  return (
    process.env.ORVYN_POSTGRES_SHADOW?.trim() === "1" &&
    Boolean(process.env.DATABASE_URL?.trim())
  );
}

export function getPostgresShadowStore(): PostgresShadowStore | null {
  if (singleton !== undefined) return singleton;
  if (!postgresShadowEnabled()) {
    singleton = null;
    return singleton;
  }

  singleton = new PostgresShadowStore(process.env.DATABASE_URL!.trim());
  return singleton;
}


export async function closePostgresShadowStore(): Promise<void> {
  if (!singleton) return;
  const active = singleton;
  singleton = undefined;
  await active.close();
}
