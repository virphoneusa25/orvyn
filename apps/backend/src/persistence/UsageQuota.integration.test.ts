import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool, type PoolClient } from "pg";
import type { AIModelProvider } from "@orvyn/ai-core";
import { PostgresMirror, postgresMirror } from "./PostgresMirror";
import { LocalStore } from "./LocalStore";
import { QuotaExceededError, UsageService } from "../services/UsageService";

const enabled = process.env.ORVYN_POSTGRES_MIRROR === "1" && Boolean(process.env.DATABASE_URL);
function primary() {
  const keys = ["ORVYN_POSTGRES_PRIMARY_READS", "ORVYN_POSTGRES_PRIMARY_WRITES", "ORVYN_QUOTA_MODEL_REQUESTS_MONTH", "ORVYN_POSTGRES_READ_FALLBACK_SQLITE", "DATABASE_URL", "ORVYN_POSTGRES_POOL_MAX"];
  const saved = keys.map(key => process.env[key]);
  process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
  process.env.ORVYN_POSTGRES_PRIMARY_WRITES = "1";
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "1";
  process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "1";
  return () => keys.forEach((key, i) => {
    if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i];
  });
}
function fakeProvider(call: () => Promise<void>): AIModelProvider {
  return {
    config: { id: "quota-test", provider: "test" },
    generate: async () => { await call(); return { content: "ok", finishReason: "stop" }; },
    stream: async function* () { await call(); yield { delta: "a" }; yield { delta: "b", done: true }; },
    generateImage: async () => { await call(); return {}; },
    healthCheck: async () => true,
    supportsTools: () => false,
    supportsVision: () => false,
  } as unknown as AIModelProvider;
}
async function invoke(provider: AIModelProvider, method: "generate" | "stream" | "image") {
  if (method === "generate") await provider.generate({ messages: [] });
  else if (method === "image") await provider.generateImage!({ prompt: "test" });
  else for await (const _ of provider.stream({ messages: [] })) { /* consume */ }
}

for (const method of ["generate", "stream", "image"] as const) {
  test(`real Postgres: two nodes compete for the final ${method} slot`, { skip: !enabled }, async () => {
    const restore = primary();
    const tenantId = `quota_${randomUUID()}`;
    const dirs = [mkdtempSync(join(tmpdir(), "quota-a-")), mkdtempSync(join(tmpdir(), "quota-b-"))];
    const stores = dirs.map(dir => new LocalStore(tenantId, dir));
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const providers = stores.map(store => {
      const usage = new UsageService(); usage.attachStore(store);
      return usage.wrap(fakeProvider(async () => { calls++; await gate; }));
    });
    const failures: unknown[] = [];
    try {
      await postgresMirror.init();
      const attempts = providers.map(provider => invoke(provider, method).catch(error => { failures.push(error); }));
      // A reservation remains visible while the winning provider is still in flight.
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          if (calls === 1 && failures.length === 1) return resolve();
          if (Date.now() >= deadline) return reject(new Error("Concurrent admission did not settle"));
          setTimeout(poll, 10);
        }; poll();
      });
      assert.equal(await postgresMirror.countReservedUsageSince(tenantId, 0), 1);
      assert.equal(await postgresMirror.countUsageSince(tenantId, 0), 0);
      assert.ok(failures[0] instanceof QuotaExceededError);
      release(); await Promise.all(attempts);
      assert.equal(calls, 1);
      assert.equal(await postgresMirror.countUsageSince(tenantId, 0), 1);
      assert.equal(await postgresMirror.countReservedUsageSince(tenantId, 0), 1);
      await assert.rejects(invoke(providers[1], method), QuotaExceededError);
    } finally {
      release(); await postgresMirror.flush();
      stores.forEach(store => store.close());
      dirs.forEach(dir => rmSync(dir, { recursive: true, force: true }));
      restore();
    }
  });
}

test("real Postgres: abandoned reservations survive reconnection and reset only next month", { skip: !enabled }, async () => {
  const restore = primary();
  const nodeA = new PostgresMirror(); const nodeB = new PostgresMirror();
  const tenantId = `abandoned_${randomUUID()}`;
  try {
    await nodeA.init(); await nodeB.init();
    const now = Date.now();
    assert.equal(await nodeA.reserveUsage(tenantId, randomUUID(), now, 1), true);
    await nodeA.close();
    assert.equal(await nodeB.reserveUsage(tenantId, randomUUID(), now, 1), false);
    const date = new Date(now);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    assert.equal(await nodeB.reserveUsage(tenantId, randomUUID(), nextMonth, 1), true);
  } finally { await nodeA.close(); await nodeB.close(); restore(); }
});

test("real Postgres: early stream closure settles one failed attempt", { skip: !enabled }, async () => {
  const restore = primary();
  const dir = mkdtempSync(join(tmpdir(), "quota-stream-"));
  const tenantId = `stream_${randomUUID()}`; const store = new LocalStore(tenantId, dir);
  try {
    const usage = new UsageService(); usage.attachStore(store);
    const provider = usage.wrap(fakeProvider(async () => {}));
    for await (const _ of provider.stream({ messages: [] })) break;
    const events = await postgresMirror.loadRecentUsage(tenantId);
    assert.equal(events.length, 1); assert.equal(events[0].ok, false);
    assert.match(events[0].error!, /closed/);
    assert.equal(await postgresMirror.countReservedUsageSince(tenantId, 0), 1);
    await assert.rejects(provider.generate({ messages: [] }), QuotaExceededError);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); restore(); }
});

test("real Postgres: failed settlement preserves the slot and replay settles it once", { skip: !enabled }, async () => {
  const restore = primary(); const mirror = new PostgresMirror();
  const tenantId = `settlement_${randomUUID()}`;
  const id = randomUUID(); const timestamp = Date.now();
  try {
    assert.equal(await mirror.reserveUsage(tenantId, id, timestamp, 1), true);
    const event = { id, timestamp, modelId: "test", provider: "test", method: "generate" as const, durationMs: 1, ok: true };
    await assert.rejects(mirror.saveUsageEvent(tenantId, { ...event, durationMs: NaN }));
    assert.equal(await mirror.reserveUsage(tenantId, randomUUID(), timestamp, 1), false);
    await mirror.saveUsageEvent(tenantId, event); await mirror.saveUsageEvent(tenantId, event);
    assert.equal(await mirror.countUsageSince(tenantId, 0), 1);
    assert.equal(await mirror.countReservedUsageSince(tenantId, 0), 1);
  } finally { await mirror.close(); restore(); }
});

test("real Postgres: pool exhaustion fails within the connection deadline and recovers", { skip: !enabled }, async () => {
  const restore = primary(); process.env.ORVYN_POSTGRES_POOL_MAX = "1";
  const mirror = new PostgresMirror();
  let held: PoolClient | undefined;
  try {
    await mirror.init();
    // Hold the only connection to simulate another request occupying the pool.
    const pool = (mirror as unknown as { pool: Pool }).pool;
    held = await pool.connect();
    const start = Date.now();
    await assert.rejects(mirror.reserveUsage(`pool_${randomUUID()}`, randomUUID(), Date.now(), 1), /timeout/i);
    assert.ok(Date.now() - start < 7000);
    held.release(); held = undefined;
    assert.equal(await mirror.reserveUsage(`pool_${randomUUID()}`, randomUUID(), Date.now(), 1), true);
  } finally { held?.release(); await mirror.close(); restore(); }
});

test("real Postgres: outage blocks provider admission even with SQLite fallback, then recovers", { skip: !enabled }, async () => {
  const restore = primary(); const originalUrl = process.env.DATABASE_URL!;
  const dir = mkdtempSync(join(tmpdir(), "quota-outage-"));
  const store = new LocalStore(`outage_${randomUUID()}`, dir);
  let calls = 0;
  try {
    await postgresMirror.flushStrict(); await postgresMirror.close();
    const unavailable = new URL(originalUrl); unavailable.port = "1";
    process.env.DATABASE_URL = unavailable.toString();
    const usage = new UsageService(); usage.attachStore(store);
    const provider = usage.wrap(fakeProvider(async () => { calls++; }));
    assert.equal((await usage.quotaAsync()).used, 0); // read fallback still works
    await assert.rejects(provider.generate({ messages: [] }));
    await assert.rejects(postgresMirror.reserveMission(store.tenantId, randomUUID(), Date.now(), 1));
    assert.equal(calls, 0); assert.equal(store.loadRecentUsage().length, 0);
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";
    await assert.rejects(usage.quotaAsync());
    await postgresMirror.close(); process.env.DATABASE_URL = originalUrl;
    await provider.generate({ messages: [] });
    assert.equal(calls, 1); assert.equal((await usage.quotaAsync()).used, 1);
  } finally {
    await postgresMirror.close(); restore();
    store.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test("real Postgres: queued mission reservations enforce the final slot across nodes", { skip: !enabled }, async () => {
  const restore = primary();
  const nodeA = new PostgresMirror(); const nodeB = new PostgresMirror();
  const tenantId = `mission_quota_${randomUUID()}`;
  const runIds = [randomUUID(), randomUUID()]; const timestamp = Date.now();
  try {
    await nodeA.init(); await nodeB.init();
    const results = await Promise.all([
      nodeA.reserveMission(tenantId, runIds[0], timestamp, 1),
      nodeB.reserveMission(tenantId, runIds[1], timestamp, 1),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await nodeA.countMissionsSince(tenantId, 0), 0);
    const runId = runIds[results.indexOf(true)];
    const mission = {
      id: randomUUID(), runId, projectRoot: "/projects/quota", goal: "test admission",
      status: "QUEUED" as const, tasks: [], reviewCycles: 0,
      createdAt: timestamp + 1000, updatedAt: timestamp + 1000,
    };
    await nodeA.saveMission(tenantId, mission);
    await nodeA.saveMission(tenantId, { ...mission, status: "RUNNING" });
    assert.equal(await nodeB.countMissionsSince(tenantId, 0), 1);
    assert.equal(await nodeB.reserveMission(tenantId, randomUUID(), timestamp, 1), false);
    const stored = await nodeB.loadMissions(tenantId);
    assert.equal(stored[0].createdAt, timestamp, "admission month survives queue delay");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const result = await pool.query("SELECT COUNT(*)::int AS n FROM mission_reservations WHERE tenant_id=$1", [tenantId]);
      assert.equal(result.rows[0].n, 0);
    } finally { await pool.end(); }
  } finally { await nodeA.close(); await nodeB.close(); restore(); }
});
