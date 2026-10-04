// Compatible tenant-data mirror for the deployed ORVYN application.
// SQLite and the existing identity/credit stores remain authoritative.
import { Pool, type PoolClient } from "pg";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import { sealModelConfig } from "../models/userModels";

export interface TenantMirrorSnapshot {
  missions: Mission[];
  usageEvents: UsageEvent[];
  settings: Array<{ key: string; value: string }>;
  models: ModelConfig[];
}

const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS orvyn_storage;
CREATE TABLE IF NOT EXISTS orvyn_storage.migrations (
  version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orvyn_storage.missions (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS orvyn_storage.usage_events (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, payload JSON NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE TABLE IF NOT EXISTS orvyn_storage.settings (
  tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS orvyn_storage.models (
  tenant_id TEXT NOT NULL, id TEXT NOT NULL, config JSON NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
INSERT INTO orvyn_storage.migrations(version) VALUES (1) ON CONFLICT DO NOTHING;
`;

export function validateTenantMirrorMode(env: NodeJS.ProcessEnv = process.env): void {
  if (env.ORVYN_POSTGRES_PRIMARY_READS?.trim() === "1" || env.ORVYN_POSTGRES_PRIMARY_WRITES?.trim() === "1") {
    throw new Error("Production compatibility integration supports PostgreSQL mirror only; primary reads/writes require identity and credit-ledger integration.");
  }
  if (env.ORVYN_POSTGRES_MIRROR?.trim() === "1" && !(env.DATABASE_URL?.trim() || env.ORVYN_PG_URL?.trim())) {
    throw new Error("PostgreSQL mirror requires DATABASE_URL or the existing ORVYN_PG_URL.");
  }
}

export class TenantPostgresMirror {
  private pool: Pool | null = null;
  private initialization: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private failures = new Set<string>();
  private queued = 0;

  isEnabled(): boolean { return process.env.ORVYN_POSTGRES_MIRROR?.trim() === "1"; }

  private getPool(): Pool {
    if (!this.pool) {
      validateTenantMirrorMode();
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL?.trim() || process.env.ORVYN_PG_URL?.trim(),
        max: 4, connectionTimeoutMillis: 5000, statement_timeout: 10000,
        lock_timeout: 5000, idleTimeoutMillis: 30000,
        application_name: "orvyn-tenant-mirror",
      });
      this.pool.on("error", () => console.warn("[tenant-mirror] idle PostgreSQL connection failed"));
    }
    return this.pool;
  }

  async init(): Promise<void> {
    if (!this.isEnabled()) return;
    if (!this.initialization) {
      this.initialization = (async () => {
        const client = await this.getPool().connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended('orvyn-tenant-mirror-migration', 0))");
          await client.query(SCHEMA);
          // JSON preserves escaped NULs in real mission/tool output. JSONB
          // rejects those strings (22P05), even though SQLite/JSON accept them.
          const version = await client.query("SELECT EXISTS(SELECT 1 FROM orvyn_storage.migrations WHERE version=2) AS applied");
          if (!version.rows[0].applied) {
            await client.query("ALTER TABLE orvyn_storage.missions ALTER COLUMN payload TYPE JSON USING payload::json");
            await client.query("ALTER TABLE orvyn_storage.usage_events ALTER COLUMN payload TYPE JSON USING payload::json");
            await client.query("ALTER TABLE orvyn_storage.models ALTER COLUMN config TYPE JSON USING config::json");
            await client.query("INSERT INTO orvyn_storage.migrations(version) VALUES (2)");
          }
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        } finally { client.release(); }
      })();
    }
    try { await this.initialization; }
    catch (error) { this.initialization = null; throw error; }
  }

  private enqueue(tenantId: string, operation: (client: PoolClient) => Promise<void>, repairs = false): void {
    if (!this.isEnabled()) return;
    this.queued++;
    this.chain = this.chain.then(async () => {
      await this.init();
      const client = await this.getPool().connect();
      try {
        await operation(client);
        if (repairs) this.failures.delete(tenantId);
      } finally { client.release(); }
    }).catch(() => {
      this.failures.add(tenantId);
      console.warn("[tenant-mirror] PostgreSQL mirror write failed; SQLite remains authoritative");
    }).finally(() => { this.queued--; });
  }

  saveMission(tenantId: string, mission: Mission): void {
    if (!this.isEnabled()) return;
    const payload = JSON.stringify(mission);
    this.enqueue(tenantId, async client => {
      await client.query(`INSERT INTO orvyn_storage.missions(tenant_id,id,payload) VALUES ($1,$2,$3::json)
        ON CONFLICT(tenant_id,id) DO UPDATE SET payload=EXCLUDED.payload`, [tenantId, mission.id, payload]);
    });
  }

  saveUsage(tenantId: string, event: UsageEvent): void {
    if (!this.isEnabled()) return;
    // Preserve the complete current wire, including embed, actual cost, rates,
    // image counts, cached tokens and estimation markers. Never invent values.
    const payload = JSON.stringify(event);
    this.enqueue(tenantId, async client => {
      await client.query(`INSERT INTO orvyn_storage.usage_events(tenant_id,id,payload) VALUES ($1,$2,$3::json)
        ON CONFLICT(tenant_id,id) DO NOTHING`, [tenantId, event.id, payload]);
    });
  }

  setSetting(tenantId: string, key: string, value: string): void {
    this.enqueue(tenantId, async client => {
      await client.query(`INSERT INTO orvyn_storage.settings(tenant_id,key,value) VALUES ($1,$2,$3)
        ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [tenantId, key, value]);
    });
  }

  deleteSetting(tenantId: string, key: string): void {
    this.enqueue(tenantId, async client => {
      await client.query("DELETE FROM orvyn_storage.settings WHERE tenant_id=$1 AND key=$2", [tenantId, key]);
    });
  }

  saveModel(tenantId: string, config: ModelConfig): void {
    if (!this.isEnabled()) return;
    // Retain the production vault format. Already-sealed configs pass through;
    // desktop/plaintext configs are sealed before leaving the local process.
    let payload: string;
    try { payload = JSON.stringify(sealModelConfig(config, tenantId)); }
    catch { this.failures.add(tenantId); return; }
    this.enqueue(tenantId, async client => {
      await client.query(`INSERT INTO orvyn_storage.models(tenant_id,id,config) VALUES ($1,$2,$3::json)
        ON CONFLICT(tenant_id,id) DO UPDATE SET config=EXCLUDED.config`, [tenantId, config.id, payload]);
    });
  }

  deleteModel(tenantId: string, id: string): void {
    this.enqueue(tenantId, async client => {
      await client.query("DELETE FROM orvyn_storage.models WHERE tenant_id=$1 AND id=$2", [tenantId, id]);
    });
  }

  backfill(tenantId: string, snapshot: TenantMirrorSnapshot): void {
    if (!this.isEnabled()) return;
    // Capture before enqueueing so mutable runtime objects cannot change the
    // snapshot while earlier mirror writes finish.
    const captured = JSON.parse(JSON.stringify(snapshot)) as TenantMirrorSnapshot;
    let models: Array<{ id: string; json: string }>;
    try { models = captured.models.map(config => ({ id: config.id, json: JSON.stringify(sealModelConfig(config, tenantId)) })); }
    catch { this.failures.add(tenantId); return; }
    this.enqueue(tenantId, async client => {
      try {
        await client.query("BEGIN");
        // SQLite is authoritative: repair missed deletions as well as upserts.
        for (const [table, ids, key] of [
          ["missions", captured.missions.map(m => m.id), "id"],
          ["usage_events", captured.usageEvents.map(e => e.id), "id"],
          ["settings", captured.settings.map(setting => setting.key), "key"],
          ["models", captured.models.map(model => model.id), "id"],
        ] as const) await client.query(`DELETE FROM orvyn_storage.${table} WHERE tenant_id=$1 AND NOT (${key}=ANY($2::text[]))`, [tenantId, ids]);
        for (const mission of captured.missions) await client.query(`INSERT INTO orvyn_storage.missions(tenant_id,id,payload)
          VALUES ($1,$2,$3::json) ON CONFLICT(tenant_id,id) DO UPDATE SET payload=EXCLUDED.payload`, [tenantId, mission.id, JSON.stringify(mission)]);
        for (const event of captured.usageEvents) await client.query(`INSERT INTO orvyn_storage.usage_events(tenant_id,id,payload)
          VALUES ($1,$2,$3::json) ON CONFLICT(tenant_id,id) DO NOTHING`, [tenantId, event.id, JSON.stringify(event)]);
        for (const setting of captured.settings) await client.query(`INSERT INTO orvyn_storage.settings(tenant_id,key,value)
          VALUES ($1,$2,$3) ON CONFLICT(tenant_id,key) DO UPDATE SET value=EXCLUDED.value`, [tenantId, setting.key, setting.value]);
        for (const config of models) await client.query(`INSERT INTO orvyn_storage.models(tenant_id,id,config)
          VALUES ($1,$2,$3::json) ON CONFLICT(tenant_id,id) DO UPDATE SET config=EXCLUDED.config`, [tenantId, config.id, config.json]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined); throw error;
      }
    }, true);
  }

  noteSnapshotFailure(tenantId: string): void {
    this.failures.add(tenantId);
    console.warn("[tenant-mirror] SQLite snapshot failed; mirror parity is unavailable");
  }

  async flush(): Promise<void> { await this.chain; }

  async status(tenantId: string): Promise<{ enabled: boolean; ready: boolean; migrationVersion?: number; failedWrites: boolean; queuedWrites: number; counts?: Record<string, number> }> {
    if (!this.isEnabled()) return { enabled: false, ready: true, failedWrites: false, queuedWrites: 0 };
    // A health request must not wait behind a large backfill/outage backlog.
    // Report it as incomplete and let the next poll measure settled parity.
    if (this.queued > 0) return { enabled:true, ready:false, failedWrites:this.failures.has(tenantId), queuedWrites:this.queued };
    try {
      await this.init();
      const result = await this.getPool().query(`SELECT
        (SELECT MAX(version) FROM orvyn_storage.migrations) AS version,
        (SELECT COUNT(*)::int FROM orvyn_storage.missions WHERE tenant_id=$1) AS missions,
        (SELECT COUNT(*)::int FROM orvyn_storage.usage_events WHERE tenant_id=$1) AS usage,
        (SELECT COUNT(*)::int FROM orvyn_storage.settings WHERE tenant_id=$1) AS settings,
        (SELECT COUNT(*)::int FROM orvyn_storage.models WHERE tenant_id=$1) AS models`, [tenantId]);
      const row = result.rows[0];
      return { enabled: true, ready: !this.failures.has(tenantId), migrationVersion: Number(row.version),
        failedWrites: this.failures.has(tenantId), queuedWrites: this.queued,
        counts: { missions: row.missions, usage: row.usage, settings: row.settings, models: row.models } };
    } catch { return { enabled: true, ready: false, failedWrites: this.failures.has(tenantId), queuedWrites: this.queued }; }
  }

  async close(): Promise<void> {
    await this.flush(); const pool = this.pool;
    this.pool = null; this.initialization = null;
    if (pool) await pool.end();
  }
}

export const tenantPostgresMirror = new TenantPostgresMirror();
