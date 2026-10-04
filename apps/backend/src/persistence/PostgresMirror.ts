// apps/backend/src/persistence/PostgresMirror.ts
//
// Phase A of the PostgreSQL migration.
//
// SQLite remains the synchronous source of truth while every durable mutation
// is mirrored asynchronously into PostgreSQL. This proves schema, networking,
// migrations, multi-process writes, and parity without forcing ORVYN's entire
// synchronous storage surface to become async in one risky cutover.
//
// Enable only with:
//   ORVYN_POSTGRES_MIRROR=1
//   DATABASE_URL=postgresql://...
//
// Phase B will introduce the async primary-store interface and switch reads.

import { Pool } from "pg";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";

const MIGRATION_VERSION = 1;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS missions (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  project_root TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  review_cycles INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  tasks_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_missions_tenant_created
  ON missions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_missions_tenant_run
  ON missions (tenant_id, run_id);

CREATE TABLE IF NOT EXISTS usage_events (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  ts BIGINT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  method TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  ok BOOLEAN NOT NULL,
  error TEXT,
  prompt_tokens BIGINT,
  completion_tokens BIGINT,
  output_chars BIGINT,
  tool_calls INTEGER,
  mission_id TEXT,
  task_id TEXT,
  agent TEXT,
  source TEXT,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_ts
  ON usage_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_usage_tenant_mission
  ON usage_events (tenant_id, mission_id);

CREATE TABLE IF NOT EXISTS tenant_settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS tenant_models (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pg_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_pg_sessions_expires ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS legal_acceptances (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  accepted_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, version)
);
`;

function enabled(): boolean {
  return (
    process.env.ORVYN_POSTGRES_MIRROR?.trim() === "1" &&
    Boolean(process.env.DATABASE_URL?.trim())
  );
}

function sslConfig(): false | { rejectUnauthorized: boolean } {
  const mode = process.env.ORVYN_POSTGRES_SSL?.trim().toLowerCase();
  if (!mode || mode === "0" || mode === "false" || mode === "disable") return false;
  return { rejectUnauthorized: process.env.ORVYN_POSTGRES_SSL_REJECT_UNAUTHORIZED?.trim() !== "0" };
}

export class PostgresMirror {
  private pool: Pool | null = null;
  private initPromise: Promise<void> | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private warned = false;

  isEnabled(): boolean {
    return enabled();
  }

  private getPool(): Pool {
    if (!this.pool) {
      if (!enabled()) throw new Error("PostgreSQL mirror is disabled");
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Math.max(1, Number(process.env.ORVYN_POSTGRES_POOL_MAX) || 10),
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
        ssl: sslConfig(),
        application_name: process.env.ORVYN_POSTGRES_APPLICATION_NAME?.trim() || "orvyn",
      });
      this.pool.on("error", (err) => {
        console.error("[postgres] idle client error", err);
      });
    }
    return this.pool;
  }

  async init(): Promise<void> {
    if (!enabled()) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      const pool = this.getPool();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(SCHEMA_V1);
        await client.query(
          "INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT(version) DO NOTHING",
          [MIGRATION_VERSION]
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    })();

    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  private async ready(): Promise<Pool> {
    await this.init();
    return this.getPool();
  }

  private report(operation: string, err: unknown): void {
    if (!this.warned) {
      this.warned = true;
      console.warn(
        `[postgres-mirror] ${operation} failed; SQLite remains authoritative: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  mirror(operation: string, fn: () => Promise<void>): void {
    if (!enabled()) return;
    // Preserve source-store write ordering (important for users -> sessions /
    // legal_acceptances foreign keys) without blocking synchronous callers.
    this.writeChain = this.writeChain
      .then(fn)
      .catch((err) => {
        this.report(operation, err);
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async health(): Promise<{
    enabled: boolean;
    status: "disabled" | "ready" | "unavailable";
    latencyMs?: number;
    error?: string;
    migrationVersion?: number;
  }> {
    if (!enabled()) return { enabled: false, status: "disabled" };

    const started = Date.now();
    try {
      const pool = await this.ready();
      const result = await pool.query<{ version: number }>(
        "SELECT COALESCE(MAX(version), 0)::int AS version FROM schema_migrations"
      );
      return {
        enabled: true,
        status: "ready",
        latencyMs: Date.now() - started,
        migrationVersion: Number(result.rows[0]?.version ?? 0),
      };
    } catch (err) {
      return {
        enabled: true,
        status: "unavailable",
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async upsertTenant(id: string, name: string, createdAt = Date.now()): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO tenants(id, name, created_at)
       VALUES ($1, $2, to_timestamp($3 / 1000.0))
       ON CONFLICT(id) DO UPDATE SET name = EXCLUDED.name`,
      [id, name, createdAt]
    );
  }

  async saveMission(tenantId: string, m: Mission): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO missions
       (tenant_id, id, run_id, project_root, goal, status, review_cycles, created_at, updated_at, tasks_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
       ON CONFLICT(tenant_id,id) DO UPDATE SET
         run_id=EXCLUDED.run_id,
         project_root=EXCLUDED.project_root,
         goal=EXCLUDED.goal,
         status=EXCLUDED.status,
         review_cycles=EXCLUDED.review_cycles,
         updated_at=EXCLUDED.updated_at,
         tasks_json=EXCLUDED.tasks_json`,
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
    );
  }

  async saveUsageEvent(tenantId: string, e: UsageEvent): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO usage_events
       (tenant_id,id,ts,model_id,provider,method,duration_ms,ok,error,prompt_tokens,
        completion_tokens,output_chars,tool_calls,mission_id,task_id,agent,source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT(tenant_id,id) DO NOTHING`,
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
    );
  }

  async setSetting(tenantId: string, key: string, value: string): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO tenant_settings(tenant_id,key,value)
       VALUES ($1,$2,$3)
       ON CONFLICT(tenant_id,key) DO UPDATE
       SET value=EXCLUDED.value, updated_at=now()`,
      [tenantId, key, value]
    );
  }

  async saveModel(tenantId: string, config: ModelConfig): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO tenant_models(tenant_id,id,config_json)
       VALUES ($1,$2,$3::jsonb)
       ON CONFLICT(tenant_id,id) DO UPDATE
       SET config_json=EXCLUDED.config_json, updated_at=now()`,
      [tenantId, config.id, JSON.stringify(config)]
    );
  }

  async deleteModel(tenantId: string, id: string): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      "DELETE FROM tenant_models WHERE tenant_id=$1 AND id=$2",
      [tenantId, id]
    );
  }

  async upsertUser(user: {
    id: string;
    email: string;
    name: string | null;
    passwordHash: string;
    createdAt: number;
  }): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO users(id,email,name,password_hash,created_at)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT(id) DO UPDATE SET
         email=EXCLUDED.email,
         name=EXCLUDED.name,
         password_hash=EXCLUDED.password_hash`,
      [user.id, user.email, user.name, user.passwordHash, user.createdAt]
    );
  }

  async upsertSession(session: {
    tokenHash: string;
    userId: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO sessions(token_hash,user_id,created_at,expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT(token_hash) DO UPDATE SET
         user_id=EXCLUDED.user_id,
         created_at=EXCLUDED.created_at,
         expires_at=EXCLUDED.expires_at`,
      [session.tokenHash, session.userId, session.createdAt, session.expiresAt]
    );
  }

  async deleteSession(tokenHash: string): Promise<void> {
    const pool = await this.ready();
    await pool.query("DELETE FROM sessions WHERE token_hash=$1", [tokenHash]);
  }

  async saveLegalAcceptance(userId: string, version: string, acceptedAt: number): Promise<void> {
    const pool = await this.ready();
    await pool.query(
      `INSERT INTO legal_acceptances(user_id,version,accepted_at)
       VALUES ($1,$2,$3)
       ON CONFLICT(user_id,version) DO UPDATE SET accepted_at=EXCLUDED.accepted_at`,
      [userId, version, acceptedAt]
    );
  }

  async parityCounts(tenantId: string): Promise<{
    missions: number;
    usageEvents: number;
    settings: number;
    models: number;
  }> {
    const pool = await this.ready();
    const result = await pool.query<{
      missions: string;
      usage_events: string;
      settings: string;
      models: string;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM missions WHERE tenant_id=$1)::text AS missions,
        (SELECT COUNT(*) FROM usage_events WHERE tenant_id=$1)::text AS usage_events,
        (SELECT COUNT(*) FROM tenant_settings WHERE tenant_id=$1)::text AS settings,
        (SELECT COUNT(*) FROM tenant_models WHERE tenant_id=$1)::text AS models`,
      [tenantId]
    );
    const row = result.rows[0];
    return {
      missions: Number(row?.missions ?? 0),
      usageEvents: Number(row?.usage_events ?? 0),
      settings: Number(row?.settings ?? 0),
      models: Number(row?.models ?? 0),
    };
  }

  async close(): Promise<void> {
    const pool = this.pool;
    this.pool = null;
    this.initPromise = null;
    if (pool) await pool.end();
  }
}

export const postgresMirror = new PostgresMirror();
