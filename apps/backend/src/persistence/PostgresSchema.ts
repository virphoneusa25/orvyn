// apps/backend/src/persistence/PostgresSchema.ts
//
// Shared tenant-data schema used by shadow migration and PostgreSQL-primary
// persistence. Auth/session tables intentionally remain outside this schema
// until the dedicated account migration phase.

import type { Pool } from "pg";

export const POSTGRES_TENANT_SCHEMA = `
CREATE TABLE IF NOT EXISTS orvyn_missions (
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
CREATE INDEX IF NOT EXISTS idx_orvyn_missions_tenant_created
  ON orvyn_missions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orvyn_missions_tenant_run
  ON orvyn_missions (tenant_id, run_id);

CREATE TABLE IF NOT EXISTS orvyn_usage_events (
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
CREATE INDEX IF NOT EXISTS idx_orvyn_usage_tenant_ts
  ON orvyn_usage_events (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_orvyn_usage_tenant_mission
  ON orvyn_usage_events (tenant_id, mission_id);

CREATE TABLE IF NOT EXISTS orvyn_usage_quota_monthly (
  tenant_id TEXT NOT NULL,
  month_start BIGINT NOT NULL,
  used_count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, month_start)
);

CREATE TABLE IF NOT EXISTS orvyn_settings (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE IF NOT EXISTS orvyn_models (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  config_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, id)
);
`;

const initialized = new WeakMap<Pool, Promise<void>>();

export function ensurePostgresTenantSchema(pool: Pool): Promise<void> {
  let init = initialized.get(pool);
  if (!init) {
    init = pool.query(POSTGRES_TENANT_SCHEMA).then(() => undefined);
    initialized.set(pool, init);
  }
  return init;
}
