import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Pool } from "pg";
import { ArtifactService } from "../artifacts/ArtifactService";
import { MINIMAL_PNG } from "../artifacts/bytes";
import { UsageService } from "../services/UsageService";
import { LocalStore } from "./LocalStore";
import { PostgresTenantStore } from "./PostgresTenantStore";
import { PostgresTenantDatabase, tenantDataSchema, tenantSql, encodeTenantText, decodeTenantText } from "./PostgresTenantDatabase";
import { PostgresTenantStorage, readTenantDataSnapshot } from "./PostgresTenantStorage";

const url = process.env.ORVYN_PG_URL ?? "";
const live = process.env.ORVYN_TENANT_RUNTIME_TEST === "1" && Boolean(url);
const content = "Unicode 🌲, NUL\0, literal \\0, quote ' and slash \\";
const usage = { id: "usage-1", timestamp: 1700000000000, modelId: "fixture", provider: "fixture", method: "generate" as const, durationMs: 1, ok: true, promptTokens: 12, completionTokens: 3, error: content };
function seed(tenant: string) {
  const directory = mkdtempSync(join(tmpdir(), "orvyn-tenant-import-"));
  const store = new LocalStore(tenant, directory);
  store.saveMission({ id: "mission", runId: "run", projectRoot: content, goal: content, status: "completed", reviewCycles: 2, createdAt: 1700000000000, updatedAt: 1700000000001, tasks: [] } as any);
  store.saveUsageEvent(usage);
  store.setSetting("fixture", content);
  store.saveMemory({ id: "memory", scope: "global", kind: "preference", title: content, content, pinned: true });
  store.saveArtifactStrict({ id: "artifact", kind: "file", name: content, path: content, tenantId: tenant, sha256: "hash", size: 12, previewable: false, downloadable: true });
  store.saveModel({ id: "my:fixture", provider: "openai-compatible", name: content, capabilities: { chat: true } } as any);
  store.saveLearningRecord({ id: "learning", kind: "fixture", payload: { content } });
  store.saveMissionCheckpoint("run", { content }, "DONE");
  store.savePreviewEnvironment({ id: "preview", runId: "run", workspaceId: "workspace", url: content, status: "ready" });
  store.saveBlobRow({ key: "blob", sha256: "hash", mediaType: "image/png", size: 12, path: content, runId: "run" });
  store.enqueueBilling(usage, false);
  store.close();
  return join(directory, `${tenant}.db`);
}

test("tenant SQL and text preserve parameter boundaries and arbitrary SQLite content", () => {
  assert.equal(decodeTenantText(encodeTenantText(content)), content);
  assert.equal(tenantSql("INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)"), "INSERT INTO settings(key,value) VALUES ($1,$2) ON CONFLICT DO NOTHING");
  assert.equal(tenantSql("SELECT '?' AS quoted, ? AS value"), "SELECT '?' AS quoted, $1 AS value");
  assert.throws(() => tenantSql("INSERT OR REPLACE INTO settings VALUES (?,?)"), /Unsupported/);
});

test("tenant snapshot rejects missing databases, foreign ownership and unknown tables", () => {
  const tenant = "source-" + randomUUID();
  const file = seed(tenant);
  const snapshot = readTenantDataSnapshot(file, tenant);
  assert.equal(Object.keys(snapshot).length, 11);
  assert.equal(snapshot.settings.rows[0]?.value, content);
  assert.equal(snapshot.memories.rows[0]?.content, content);
  assert.throws(() => readTenantDataSnapshot(file + ".missing", tenant), /Missing/);
  assert.throws(() => readTenantDataSnapshot(file, "foreign"), /foreign artifact/);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE unexpected(value TEXT)"); db.close();
  assert.throws(() => readTenantDataSnapshot(file, tenant), /Unexpected/);
});

async function cleanup(tenant: string) {
  const pool = new Pool({ connectionString: url });
  try { await pool.query(`DROP SCHEMA IF EXISTS ${tenantDataSchema(tenant)} CASCADE`); } finally { await pool.end(); }
}

test("real PostgreSQL: all tenant families import exactly and preserve behavior after restart", { skip: !live }, async () => {
  const tenant = "import-" + randomUUID();
  const file = seed(tenant);
  const migration = await PostgresTenantStorage.connect(url, tenant);
  let store: PostgresTenantStore | undefined;
  try {
    assert.equal((await migration.importSqlite(file)).tables, 11);
    assert.deepEqual(await migration.exportSnapshot(), JSON.parse(JSON.stringify(readTenantDataSnapshot(file, tenant))));
    assert.equal((await migration.importSqlite(file)).alreadyImported, true);
    store = await PostgresTenantStore.connect(url, tenant);
    assert.equal(await store.getSetting("fixture"), content);
    assert.equal((await store.loadMissions())[0]?.goal, content);
    assert.equal((await store.loadRecentUsage())[0]?.error, content);
    assert.equal(await store.countUsageSince(0), 1);
    assert.equal(await store.countMissionsSince(0), 1);
    assert.equal((await store.getMemory("memory"))?.content, content);
    assert.equal((await store.getArtifact("artifact"))?.name, content);
    assert.equal((await store.listLearningRecords("fixture"))[0]?.payload && ((await store.listLearningRecords("fixture"))[0]!.payload as any).content, content);
    assert.deepEqual(await store.loadMissionCheckpoint("run"), { content });
    assert.equal((await store.previewEnvironmentFor("run", "workspace"))?.url, content);
    assert.equal((await store.getBlobRow("blob"))?.path, content);
    assert.equal((await store.loadModels())[0]?.name, content);
    assert.equal((await store.pendingBilling())[0]?.event.id, "usage-1");
    await store.saveUsageEvent(usage); assert.equal(await store.countUsageSince(0), 1);
    await store.close(); store = await PostgresTenantStore.connect(url, tenant);
    assert.equal(await store.getSetting("fixture"), content);
    await store.completeBilling("usage-1"); assert.deepEqual(await store.pendingBilling(), []);
    await assert.rejects(migration.importSqlite(file), /differs/);
  } finally { await store?.close(); await migration.close(); await cleanup(tenant); }
});

test("real PostgreSQL: concurrent settings edits serialize without lost permissions", { skip: !live }, async () => {
  const tenant = "concurrent-" + randomUUID();
  const first = await PostgresTenantStore.connect(url, tenant);
  const second = await PostgresTenantStore.connect(url, tenant);
  try {
    await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? first : second).saveToolApprovalGrant("always", "user", `tool-${i}`, "chat", "project")));
    assert.equal((await first.getToolApprovalGrants("user", "chat", "project")).length, 16);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? first : second).setToolOverride("root", `tool-${i}`, "allowed")));
    assert.equal(Object.keys(await second.getToolOverrides("root")).length, 12);
    await first.clearToolApprovalGrants("user", "tool-0");
    assert.equal((await second.getToolApprovalGrants("user", "chat", "project")).includes("tool-0"), false);
  } finally { await first.close(); await second.close(); await cleanup(tenant); }
});

test("real PostgreSQL: failed writes roll back and storage errors never degrade into empty grants", { skip: !live }, async () => {
  const tenant = "failure-" + randomUUID();
  const database = await PostgresTenantDatabase.connect(url, tenant);
  const store = await PostgresTenantStore.connect(url, tenant);
  const pool = new Pool({ connectionString: url });
  try {
    await assert.rejects(database.transaction(async () => {
      await database.prepare("INSERT INTO settings(key,value) VALUES (?,?)").run("rollback", "value");
      await database.prepare("INSERT INTO nonexistent(value) VALUES (?)").run("fail");
    }));
    assert.equal(await store.getSetting("rollback"), null);
    await pool.query(`DROP TABLE ${tenantDataSchema(tenant)}.settings`);
    await assert.rejects(store.getToolApprovalGrants("user", "chat", "project"));
    await assert.rejects(store.saveToolApprovalGrant("always", "user", "tool", "chat", "project"));
    await assert.rejects(store.clearToolApprovalGrants("user", "tool"));
  } finally { await pool.end(); await store.close(); await database.close(); await cleanup(tenant); }
});

test("real PostgreSQL: a failed final import table rolls back all eleven families", { skip: !live }, async () => {
  const tenant = "atomic-" + randomUUID();
  const migration = await PostgresTenantStorage.connect(url, tenant);
  const pool = new Pool({ connectionString: url });
  const schema = tenantDataSchema(tenant);
  try {
    await pool.query(`CREATE FUNCTION ${schema}.reject_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_import BEFORE INSERT ON ${schema}.billing_outbox FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_import()`);
    await assert.rejects(migration.importSqlite(seed(tenant)), /synthetic failure/);
    assert.equal(Object.values(await migration.exportSnapshot()).every(table => table.rows.length === 0), true);
  } finally { await pool.end(); await migration.close(); await cleanup(tenant); }
});


test("real PostgreSQL: metered provider completion persists usage and restores quota state", { skip: !live }, async () => {
  const tenant = "metered-" + randomUUID();
  const store = await PostgresTenantStore.connect(url, tenant);
  try {
    const usage = new UsageService(); await usage.attachStore(store);
    const provider = {
      config: { id: "fixture", provider: "openai-compatible" },
      async generate() { return { content: "fixture", usage: { promptTokens: 12, completionTokens: 3 } }; },
      async *stream() { yield { delta: "fixture", done: true }; },
      async healthCheck() { return true; }, supportsTools() { return false; }, supportsVision() { return false; },
    } as any;
    await usage.wrap(provider).generate({ messages: [] });
    const persisted = await store.loadRecentUsage();
    assert.equal(persisted.length, 1); assert.equal(persisted[0].promptTokens, 12);
    const restarted = new UsageService(); await restarted.attachStore(store);
    assert.equal(restarted.recent()[0].id, persisted[0].id);
    assert.equal((await restarted.quotaAsync()).used, 1);
  } finally { await store.close(); await cleanup(tenant); }
});


test("real PostgreSQL: artifacts persist metadata before success and reopen with verified bytes", { skip: !live }, async () => {
  const tenant = "artifact-" + randomUUID(), directory = mkdtempSync(join(tmpdir(), "orvyn-pg-artifact-"));
  let store = await PostgresTenantStore.connect(url, tenant);
  try {
    const service = new ArtifactService(tenant, store, directory);
    const record = await service.persistArtifact({ name: "fixture.png", kind: "generated", bytes: MINIMAL_PNG, mediaType: "image/png" });
    assert.equal((await service.listArtifacts()).length, 1);
    await store.close(); store = await PostgresTenantStore.connect(url, tenant);
    const reopened = new ArtifactService(tenant, store, directory);
    assert.equal((await reopened.getArtifact(record.artifactId))?.sha256, record.sha256);
    assert.equal((await reopened.read(record.artifactId)).bytes.equals(MINIMAL_PNG), true);
    await reopened.deleteArtifact(record.artifactId);
    assert.equal(await reopened.getArtifact(record.artifactId), null);
  } finally { await store.close(); await cleanup(tenant); rmSync(directory, { recursive: true, force: true }); }
});

test("real PostgreSQL: missions acknowledge transitions and reconcile interrupted history on restart", { skip: !live }, async () => {
  const { TaskEngine } = await import("../agent/TaskEngine");
  const { EventBus } = await import("../agent/EventBus");
  const { RunStore } = await import("../agent/events");
  const tenant = "mission-" + randomUUID();
  let store = await PostgresTenantStore.connect(url, tenant);
  try {
    const engine = new TaskEngine(new EventBus(new RunStore()), store);
    const mission = await engine.createMission("fixture-run", "/fixture", "fixture mission");
    const task = (await engine.addTask(mission.id, "fixture task", "coder"))!;
    await engine.setMissionStatus(mission.id, "RUNNING");
    await engine.transition(mission.id, task.id, "RUNNING");
    assert.equal((await store.loadMissions())[0].tasks[0].status, "RUNNING");
    await store.close(); store = await PostgresTenantStore.connect(url, tenant);
    const restarted = new TaskEngine(new EventBus(new RunStore()), store);
    assert.equal((await restarted.getMission(mission.id))!.status, "FAILED");
    assert.equal((await store.loadMissions())[0].status, "FAILED");
  } finally { await store.close(); await cleanup(tenant); }
});

test("real PostgreSQL: learning history survives restart and remains tenant isolated", { skip: !live }, async () => {
  const { ExperienceStore } = await import("../learning/ExperienceStore");
  const tenant = "learning-" + randomUUID(), other = "learning-other-" + randomUUID();
  let store = await PostgresTenantStore.connect(url, tenant);
  const otherStore = await PostgresTenantStore.connect(url, other);
  try {
    const experience = new ExperienceStore(tenant, store);
    const { RunStore } = await import("../agent/events");
    const fixture = new RunStore().create("fixture-run", "/fixture", "completed");
    const captured = await experience.captureFromRun(fixture);
    await store.close(); store = await PostgresTenantStore.connect(url, tenant);
    const restarted = new ExperienceStore(tenant, store);
    assert.equal((await restarted.list())[0].id, captured.id);
    assert.equal((await restarted.overview()).successfulRuns, 1);
    assert.equal((await new ExperienceStore(other, otherStore).list()).length, 0);
  } finally { await store.close(); await otherStore.close(); await cleanup(tenant); await cleanup(other); }
});
