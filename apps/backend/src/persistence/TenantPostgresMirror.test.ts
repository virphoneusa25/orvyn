import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import type { ModelConfig } from "@orvyn/ai-core";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import { LocalStore } from "./LocalStore";
import { TenantPostgresMirror, tenantPostgresMirror, validateTenantMirrorMode } from "./TenantPostgresMirror";
import { openModelConfig, sealModelConfig } from "../models/userModels";
import { migratePostgresIdentity } from "../identity/postgres";

const integration = process.env.ORVYN_POSTGRES_MIRROR === "1" && Boolean(process.env.ORVYN_PG_URL || process.env.DATABASE_URL);
const configured = process.env.ORVYN_POSTGRES_MIRROR;
const restoreFlag = () => { if (configured === undefined) delete process.env.ORVYN_POSTGRES_MIRROR; else process.env.ORVYN_POSTGRES_MIRROR = configured; };
const url = () => process.env.DATABASE_URL || process.env.ORVYN_PG_URL;
const mission = (): Mission => ({ id: "shared", runId: "run", projectRoot: "/projects/test", goal: "mirror", status: "RUNNING", tasks: [], reviewCycles: 0, createdAt: Date.now(), updatedAt: Date.now() });
const config = (): ModelConfig => ({ id: "my:test", name: "Customer model", provider: "openai-compatible", endpoint: "https://example.invalid", apiKey: "customer-key", contextWindow: 8192, maxOutputTokens: 1024, defaultTemperature: 0.2, defaultTopP: 1, streaming: true, capabilities: { chat:true, code:true, agent:true, tools:true, vision:false, embeddings:false, completion:true, image:false } });
const event = (): UsageEvent => ({ id: "shared", timestamp: Date.now(), modelId: "test", provider: "test", method: "embed", durationMs: 1, ok: true, promptTokens: 12, completionTokens: 0, cachedTokens: 4, providerCostUsd: 0.003, estimated: false, imageCount: 1, imageRate: { usdPerImage: 0.003, premium: true } as UsageEvent["imageRate"] });

after(async () => { await tenantPostgresMirror.close(); restoreFlag(); });

test("production mirror rejects unsupported primary modes and incomplete configuration", () => {
  assert.throws(() => validateTenantMirrorMode({ ORVYN_POSTGRES_PRIMARY_READS: "1" }), /mirror only/);
  assert.throws(() => validateTenantMirrorMode({ ORVYN_POSTGRES_PRIMARY_WRITES: "1" }), /mirror only/);
  assert.throws(() => validateTenantMirrorMode({ ORVYN_POSTGRES_MIRROR: "1" }), /requires/);
  assert.doesNotThrow(() => validateTenantMirrorMode({ ORVYN_POSTGRES_MIRROR: "1", ORVYN_PG_URL: "postgres://existing" }));
  assert.doesNotThrow(() => validateTenantMirrorMode({}));
});

test("mirror-off mode preserves tenant memory, artifacts, billing outbox and model settings", async () => {
  process.env.ORVYN_POSTGRES_MIRROR = "0";
  const dir = mkdtempSync(join(tmpdir(), "mirror-local-"));
  const store = new LocalStore("local", dir);
  try {
    store.saveMission(mission()); store.saveUsageEvent(event()); store.setSetting("profile", "BALANCED");
    store.saveModel(config()); store.saveMemory({ id:"memory", scope:"global", kind:"fact", title:"Saved", content:"Existing memory" });
    store.enqueueBilling(event(), false);
    assert.equal(store.listMemories().length, 1);
    assert.equal(store.pendingBilling().length, 1);
    assert.equal(store.getSetting("profile"), "BALANCED");
    assert.equal(store.loadModels()[0].apiKey, "customer-key");
    assert.equal(store.tenantMirrorSnapshot().missions.length, 1);
    assert.deepEqual(await tenantPostgresMirror.status("local"), { enabled:false, ready:true, failedWrites:false, queuedWrites:0 });
  } finally { store.close(); rmSync(dir, { recursive:true, force:true }); restoreFlag(); }
});

test("real Postgres: concurrent mirror migrations coexist with production identity schema", { skip:!integration }, async () => {
  await migratePostgresIdentity(url());
  const a = new TenantPostgresMirror(); const b = new TenantPostgresMirror();
  try {
    await Promise.all([a.init(), b.init()]);
    const pool = new Pool({ connectionString:url() });
    try {
      const result = await pool.query("SELECT to_regclass('public.identity_organizations') AS identity, to_regclass('orvyn_storage.missions') AS missions");
      assert.ok(result.rows[0].identity); assert.ok(result.rows[0].missions);
      const identityId = randomUUID();
      await pool.query("INSERT INTO public.identity_users(id,email,name,created_at) VALUES ($1,$2,$3,$4)",
        [identityId, `${identityId}@example.invalid`, "Existing identity", 1]);
      a.backfill("coexistence", { missions:[], usageEvents:[], models:[], settings:[] });
      await a.flush();
      const preserved = await pool.query("SELECT name FROM public.identity_users WHERE id=$1", [identityId]);
      assert.equal(preserved.rows[0].name, "Existing identity");
    } finally { await pool.end(); }
  } finally { await a.close(); await b.close(); }
});

test("real Postgres: live mirroring retains billing metadata, tenant isolation and production vault format", { skip:!integration }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-live-"));
  const tenants = [randomUUID(), randomUUID()]; const stores = tenants.map(id => new LocalStore(id, dir));
  const usage = event(); const model = config();
  try {
    stores[0].saveMission(mission()); stores[1].saveMission({ ...mission(), goal:"Other tenant" });
    stores[0].saveUsageEvent(usage); stores[1].saveUsageEvent({ ...usage, promptTokens:30 });
    stores[0].setSetting("profile", "BALANCED");
    stores[0].saveModel(sealModelConfig(model, tenants[0]));
    await tenantPostgresMirror.flush();
    const pool = new Pool({ connectionString:url() });
    try {
      const rows = await pool.query("SELECT tenant_id,payload FROM orvyn_storage.usage_events WHERE tenant_id=ANY($1::text[])", [tenants]);
      assert.equal(rows.rows.length, 2);
      assert.deepEqual(rows.rows.find(row => row.tenant_id === tenants[0]).payload, usage);
      const saved = await pool.query("SELECT config FROM orvyn_storage.models WHERE tenant_id=$1", [tenants[0]]);
      assert.equal(saved.rows[0].config.apiKey, undefined);
      assert.match(saved.rows[0].config.apiKeySealed, /^orvyn:v1:/);
      assert.equal(openModelConfig(saved.rows[0].config, tenants[0]).apiKey, model.apiKey);
      assert.throws(() => openModelConfig(saved.rows[0].config, tenants[1]), /unsealed/);
      // Reopening/backfill cannot replace rich provider settlement metadata
      // with the older, smaller SQLite Reports representation.
      tenantPostgresMirror.backfill(tenants[0], stores[0].tenantMirrorSnapshot());
      await tenantPostgresMirror.flush();
      const replay = await pool.query("SELECT payload FROM orvyn_storage.usage_events WHERE tenant_id=$1", [tenants[0]]);
      assert.deepEqual(replay.rows[0].payload, usage);
    } finally { await pool.end(); }
    assert.deepEqual((await tenantPostgresMirror.status(tenants[0])).counts, stores[0].tenantMirrorCounts());
    stores[0].deleteModel(model.id); stores[0].setSetting("profile", "AUTONOMOUS");
    await tenantPostgresMirror.flush();
    assert.deepEqual((await tenantPostgresMirror.status(tenants[0])).counts, stores[0].tenantMirrorCounts());
  } finally { await tenantPostgresMirror.flush(); stores.forEach(store => store.close()); rmSync(dir, { recursive:true, force:true }); }
});

test("real Postgres: startup backfills usage older than the bounded Reports window", { skip:!integration }, async () => {
  process.env.ORVYN_POSTGRES_MIRROR = "0";
  const dir = mkdtempSync(join(tmpdir(), "mirror-history-")); const tenant = randomUUID();
  let store = new LocalStore(tenant, dir);
  try {
    for (let i=0; i<5001; i++) store.saveUsageEvent({ ...event(), id:`old_${i}`, timestamp:i });
    store.close(); restoreFlag(); store = new LocalStore(tenant, dir);
    await tenantPostgresMirror.flush();
    assert.equal((await tenantPostgresMirror.status(tenant)).counts?.usage, 5001);
  } finally { store.close(); restoreFlag(); rmSync(dir, { recursive:true, force:true }); }
});

test("real Postgres: outage keeps SQLite usable and reopening repairs missed writes and deletions", { skip:!integration }, async () => {
  const savedDatabaseUrl = process.env.DATABASE_URL; const savedPgUrl = process.env.ORVYN_PG_URL;
  const original = url()!;
  const dir = mkdtempSync(join(tmpdir(), "mirror-outage-")); const tenant = randomUUID();
  let store = new LocalStore(tenant, dir);
  try {
    store.saveModel(config()); await tenantPostgresMirror.flush();
    await tenantPostgresMirror.close();
    const unavailable = new URL(original); unavailable.port="1";
    process.env.DATABASE_URL = unavailable.toString();
    store.deleteModel(config().id); store.saveUsageEvent(event()); store.setSetting("profile", "AUTONOMOUS");
    await tenantPostgresMirror.flush();
    assert.equal(store.loadRecentUsage().length, 1); assert.equal(store.loadModels().length, 0);
    assert.equal((await tenantPostgresMirror.status(tenant)).ready, false);
    await tenantPostgresMirror.close();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=savedDatabaseUrl;
    if (savedPgUrl === undefined) delete process.env.ORVYN_PG_URL; else process.env.ORVYN_PG_URL=savedPgUrl;
    store.close(); store = new LocalStore(tenant, dir);
    const status = await tenantPostgresMirror.status(tenant);
    assert.equal(status.ready, true); assert.equal(status.failedWrites, false);
    assert.deepEqual(status.counts, store.tenantMirrorCounts());
  } finally {
    await tenantPostgresMirror.close(); store.close();
    if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL=savedDatabaseUrl;
    if (savedPgUrl === undefined) delete process.env.ORVYN_PG_URL; else process.env.ORVYN_PG_URL=savedPgUrl;
    rmSync(dir, { recursive:true, force:true });
  }
});
