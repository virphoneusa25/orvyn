// apps/backend/src/persistence/PostgresBackfill.ts
//
// Phase B migration tooling: backfill SQLite tenant snapshots into the
// PostgreSQL shadow schema, then compare record counts.
//
// This tool is safe to run repeatedly because all shadow writes are idempotent
// upserts / INSERT ... ON CONFLICT DO NOTHING.

import { Pool } from "pg";
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
  matches: boolean;
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
  const [missions, usage, settings, models] = await Promise.all([
    pool.query("SELECT COUNT(*)::int AS n FROM orvyn_missions WHERE tenant_id=$1", [tenantId]),
    pool.query("SELECT COUNT(*)::int AS n FROM orvyn_usage_events WHERE tenant_id=$1", [tenantId]),
    pool.query("SELECT COUNT(*)::int AS n FROM orvyn_settings WHERE tenant_id=$1", [tenantId]),
    pool.query("SELECT COUNT(*)::int AS n FROM orvyn_models WHERE tenant_id=$1", [tenantId]),
  ]);

  const sqlite = {
    missions: snapshot.missions.length,
    usage: snapshot.usage.length,
    settings: snapshot.settings.length,
    models: snapshot.models.length,
  };
  const postgres = {
    missions: Number(missions.rows[0]?.n ?? 0),
    usage: Number(usage.rows[0]?.n ?? 0),
    settings: Number(settings.rows[0]?.n ?? 0),
    models: Number(models.rows[0]?.n ?? 0),
  };

  return {
    tenantId,
    sqlite,
    postgres,
    matches:
      sqlite.missions === postgres.missions &&
      sqlite.usage === postgres.usage &&
      sqlite.settings === postgres.settings &&
      sqlite.models === postgres.models,
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
