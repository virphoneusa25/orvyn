// apps/backend/src/persistence/PostgresMirror.integration.test.ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ModelConfig } from "@orvyn/ai-core";
import { LocalStore } from "./LocalStore";
import { postgresMirror } from "./PostgresMirror";
import { AuthService } from "../auth/AuthService";
import { TenantManager } from "../tenancy/TenantManager";
import { EventBus } from "../agent/EventBus";
import { RunStore } from "../agent/events";
import { TaskEngine } from "../agent/TaskEngine";
import type { Mission } from "../agent/TaskEngine";
import { QuotaExceededError, UsageService, type UsageEvent } from "../services/UsageService";

const enabled =
  process.env.ORVYN_POSTGRES_MIRROR === "1" &&
  Boolean(process.env.DATABASE_URL);

function model(id: string): ModelConfig {
  return {
    id,
    name: id,
    provider: "openai-compatible",
    endpoint: "https://example.invalid",
    apiKey: "test",
    contextWindow: 8192,
    maxOutputTokens: 1024,
    defaultTemperature: 0.2,
    defaultTopP: 1,
    streaming: true,
    capabilities: {
      chat: true,
      code: true,
      agent: true,
      tools: true,
      vision: false,
      embeddings: false,
      completion: true,
      image: false,
    },
  };
}

test(
  "real Postgres: migrations, tenant backfill, and live dual-write reach parity",
  { skip: !enabled },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orvyn-pg-mirror-"));
    const tenantId = `tenant_pg_${Date.now()}`;
    const store = new LocalStore(tenantId, dir);

    try {
      const health = await postgresMirror.health();
      assert.equal(health.status, "ready");
      assert.equal(health.migrationVersion, 1);

      await postgresMirror.upsertTenant(tenantId, "Postgres Integration");

      const mission: Mission = {
        id: "mission_1",
        runId: "run_1",
        projectRoot: "/projects/integration",
        goal: "validate postgres mirror",
        status: "RUNNING",
        tasks: [],
        reviewCycles: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      store.saveMission(mission);

      const usage: UsageEvent = {
        id: "usage_1",
        timestamp: Date.now(),
        modelId: "test-model",
        provider: "test",
        method: "generate",
        durationMs: 10,
        ok: true,
        promptTokens: 10,
        completionTokens: 5,
      };
      store.saveUsageEvent(usage);
      store.setSetting("profile", "BALANCED");
      store.saveModel(model("tenant-model"));

      // Exercise idempotent full backfill too; rows must not duplicate.
      postgresMirror.backfillTenant(
        tenantId,
        store.exportForPostgresMigration()
      );
      await postgresMirror.flush();

      const sqlite = store.parityCounts();
      const pg = await postgresMirror.parityCounts(tenantId);
      assert.deepEqual(pg, sqlite);
      assert.deepEqual(pg, {
        missions: 1,
        usageEvents: 1,
        settings: 1,
        models: 1,
      });
      assert.equal(await postgresMirror.countMissionsSince(tenantId, 0), 1);
      assert.equal(await postgresMirror.countUsageSince(tenantId, 0), 1);

      const totals = await postgresMirror.usageTotals(tenantId);
      assert.equal(totals.requests, 1);
      assert.equal(totals.promptTokens, 10);
      assert.equal(totals.completionTokens, 5);
      assert.equal(totals.errors, 0);
      assert.equal(totals.byModel["test-model"]?.requests, 1);

      const recentUsage = await postgresMirror.loadRecentUsage(tenantId, 10);
      assert.equal(recentUsage.length, 1);
      assert.equal(recentUsage[0]?.id, usage.id);
      assert.equal(recentUsage[0]?.modelId, usage.modelId);
      const pgMissions = await postgresMirror.loadMissions(tenantId);
      assert.equal(pgMissions.length, 1);
      assert.equal(pgMissions[0]?.id, mission.id);
      assert.equal(pgMissions[0]?.status, "RUNNING");
      assert.equal((await postgresMirror.getMission(tenantId, mission.id))?.goal, mission.goal);

      mission.status = "COMPLETED";
      mission.updatedAt = Date.now() + 1;
      store.saveMission(mission);
      store.setSetting("profile", "AUTONOMOUS");
      store.deleteModel("tenant-model");
      await postgresMirror.flush();

      assert.deepEqual(
        await postgresMirror.parityCounts(tenantId),
        store.parityCounts()
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);

test(
  "real Postgres: ordered auth mirror satisfies users -> legal/session foreign keys",
  { skip: !enabled },
  async () => {
    const suffix = Date.now().toString(36);
    const userId = `user_pg_${suffix}`;
    const tokenHash = `token_${suffix}`;
    const before = await postgresMirror.authParityCounts();

    postgresMirror.mirror("test-auth-user", () =>
      postgresMirror.upsertUser({
        id: userId,
        email: `pg-${suffix}@example.com`,
        name: "Postgres Test",
        passwordHash: "scrypt:16384:test:test",
        createdAt: Date.now(),
      })
    );
    postgresMirror.mirror("test-auth-legal", () =>
      postgresMirror.saveLegalAcceptance(userId, "test-v1", Date.now())
    );
    postgresMirror.mirror("test-auth-session", () =>
      postgresMirror.upsertSession({
        tokenHash,
        userId,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      })
    );

    await postgresMirror.flush();

    const after = await postgresMirror.authParityCounts();
    assert.equal(after.users, before.users + 1);
    assert.equal(after.legalAcceptances, before.legalAcceptances + 1);
    assert.equal(after.sessions, before.sessions + 1);

    postgresMirror.mirror("test-auth-session-delete", () =>
      postgresMirror.deleteSession(tokenHash)
    );
    await postgresMirror.flush();

    const deleted = await postgresMirror.authParityCounts();
    assert.equal(deleted.sessions, before.sessions);
  }
);


after(async () => {
  await postgresMirror.close();
});


test(
  "real Postgres: staged primary session and legal reads work after async auth flush",
  { skip: !enabled },
  async () => {
    const savedPrimary = process.env.ORVYN_POSTGRES_PRIMARY_READS;
    const savedFallback = process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
    process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";

    const dir = mkdtempSync(join(tmpdir(), "orvyn-auth-pg-primary-"));
    const auth = new AuthService(dir);

    try {
      const suffix = Date.now().toString(36);
      const result = await auth.registerAsync(
        `primary-${suffix}@example.com`,
        "CorrectHorseBatteryStaple!",
        "Primary Read",
        { accepted: true, version: "2026-10-01" }
      );

      const verified = await auth.verifyAsync(result.token);
      assert.equal(verified?.id, result.user.id);
      assert.equal(verified?.email, result.user.email);

      const legal = await auth.getLegalAcceptanceAsync(
        result.user.id,
        "2026-10-01"
      );
      assert.equal(legal?.version, "2026-10-01");

      // Prove credential lookup is actually PostgreSQL-backed: this second
      // AuthService has an empty SQLite database but can still authenticate
      // the user created above.
      const secondDir = mkdtempSync(join(tmpdir(), "orvyn-auth-pg-secondary-"));
      const secondary = new AuthService(secondDir);
      try {
        const login = await secondary.loginAsync(
          result.user.email,
          "CorrectHorseBatteryStaple!"
        );
        assert.equal(login.user.id, result.user.id);
        assert.equal(await secondary.verifyAsync(login.token).then((u) => u?.id), result.user.id);
        await secondary.logoutAsync(login.token);
      } finally {
        secondary.close();
        rmSync(secondDir, { recursive: true, force: true });
      }

      await auth.logoutAsync(result.token);
      assert.equal(await auth.verifyAsync(result.token), null);
    } finally {
      auth.close();
      rmSync(dir, { recursive: true, force: true });
      if (savedPrimary === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_READS;
      else process.env.ORVYN_POSTGRES_PRIMARY_READS = savedPrimary;
      if (savedFallback === undefined) delete process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
      else process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = savedFallback;
    }
  }
);


test(
  "real Postgres: UsageService primary quota read sees Postgres-only usage",
  { skip: !enabled },
  async () => {
    const savedPrimary = process.env.ORVYN_POSTGRES_PRIMARY_READS;
    const savedFallback = process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
    const savedQuota = process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;

    process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";
    process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "1";

    const dir = mkdtempSync(join(tmpdir(), "orvyn-usage-pg-primary-"));
    const tenantId = `tenant_quota_${Date.now()}`;
    const store = new LocalStore(tenantId, dir);

    try {
      await postgresMirror.upsertTenant(tenantId, "Quota Primary Test");
      await postgresMirror.saveUsageEvent(tenantId, {
        id: "pg-only-usage",
        timestamp: Date.now(),
        modelId: "pg-only-model",
        provider: "test",
        method: "generate",
        durationMs: 1,
        ok: true,
      });

      assert.equal(store.countUsageSince(0), 0, "SQLite source should be empty");

      const usage = new UsageService();
      usage.attachStore(store);

      const quota = await usage.quotaAsync();
      assert.equal(quota.used, 1);
      assert.equal(quota.remaining, 0);

      await assert.rejects(
        () => usage.checkQuotaAsync(),
        (err: unknown) =>
          err instanceof QuotaExceededError &&
          /1\/1/.test(err.message)
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });

      if (savedPrimary === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_READS;
      else process.env.ORVYN_POSTGRES_PRIMARY_READS = savedPrimary;
      if (savedFallback === undefined) delete process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
      else process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = savedFallback;
      if (savedQuota === undefined) delete process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
      else process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = savedQuota;
    }
  }
);


test(
  "real Postgres: fresh API node reconstructs tenant models routing and profile from primary store",
  { skip: !enabled },
  async () => {
    const savedPrimary = process.env.ORVYN_POSTGRES_PRIMARY_READS;
    const savedFallback = process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
    const savedDataDir = process.env.ORVYN_DATA_DIR;

    process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";

    const dir = mkdtempSync(join(tmpdir(), "orvyn-tenant-pg-bootstrap-"));
    process.env.ORVYN_DATA_DIR = dir;

    const userId = `bootstrap_${Date.now()}`;
    const tenantId = `user_${userId}`;
    const customModel = model(`pg-custom-${Date.now()}`);

    try {
      await postgresMirror.upsertTenant(tenantId, "Fresh Node User");
      await postgresMirror.saveModel(tenantId, customModel);
      await postgresMirror.setSetting(tenantId, "profile", "AUTONOMOUS");
      await postgresMirror.setSetting(
        tenantId,
        "routing",
        JSON.stringify({ chat: customModel.id })
      );

      const manager = new TenantManager();
      const tenant = await manager.ensureUserTenantAsync(
        userId,
        "fresh-node@example.com"
      );

      assert.ok(
        tenant.modelService.registry.get(customModel.id),
        "custom model should hydrate from PostgreSQL before ModelService routing is restored"
      );
      assert.equal(
        tenant.modelService.router.resolve("chat").config.id,
        customModel.id
      );
      assert.equal(tenant.toolGateway.profile, "AUTONOMOUS");

      // The node-local SQLite store is only a cache in this mode, but it
      // should now contain the Postgres snapshot for local compatibility.
      assert.equal(tenant.localStore.getSetting("profile"), "AUTONOMOUS");
      assert.equal(
        JSON.parse(tenant.localStore.getSetting("routing") ?? "{}").chat,
        customModel.id
      );
      assert.equal(
        tenant.localStore.loadModels().some((cfg) => cfg.id === customModel.id),
        true
      );

      tenant.localStore.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });

      if (savedPrimary === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_READS;
      else process.env.ORVYN_POSTGRES_PRIMARY_READS = savedPrimary;
      if (savedFallback === undefined) delete process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
      else process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = savedFallback;
      if (savedDataDir === undefined) delete process.env.ORVYN_DATA_DIR;
      else process.env.ORVYN_DATA_DIR = savedDataDir;
    }
  }
);


test(
  "real Postgres: TaskEngine durable wrappers acknowledge mission/task writes before returning",
  { skip: !enabled },
  async () => {
    const savedWrites = process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
    process.env.ORVYN_POSTGRES_PRIMARY_WRITES = "1";

    const dir = mkdtempSync(join(tmpdir(), "orvyn-task-pg-primary-"));
    const tenantId = `tenant_task_primary_${Date.now()}`;
    const store = new LocalStore(tenantId, dir);

    try {
      await postgresMirror.upsertTenant(tenantId, "Task Primary Test");

      const engine = new TaskEngine(new EventBus(new RunStore()), store, {
        shouldFailRecoveredMission: () => false,
      });

      const mission = await engine.createMissionDurable(
        "run-task-primary",
        "/projects/task-primary",
        "prove durable writes"
      );
      await engine.setMissionStatusDurable(mission.id, "RUNNING");

      const task = await engine.addTaskDurable(
        mission.id,
        "edit the source",
        "coder"
      );
      assert.ok(task);

      await engine.transitionDurable(mission.id, task!.id, "RUNNING");
      task!.attempts = 1;
      task!.result = "done";
      await engine.transitionDurable(mission.id, task!.id, "REVIEW");
      await engine.transitionDurable(mission.id, task!.id, "COMPLETED");
      await engine.incrementReviewCyclesDurable(mission.id);
      await engine.setMissionStatusDurable(mission.id, "COMPLETED");

      // No additional flush here: durable wrapper return itself is the
      // acknowledgement contract.
      const persisted = await postgresMirror.getMission(tenantId, mission.id);
      assert.ok(persisted);
      assert.equal(persisted?.status, "COMPLETED");
      assert.equal(persisted?.reviewCycles, 1);
      assert.equal(persisted?.tasks.length, 1);
      assert.equal(persisted?.tasks[0]?.status, "COMPLETED");
      assert.equal(persisted?.tasks[0]?.attempts, 1);
      assert.equal(persisted?.tasks[0]?.result, "done");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      if (savedWrites === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
      else process.env.ORVYN_POSTGRES_PRIMARY_WRITES = savedWrites;
    }
  }
);

test(
  "real Postgres: strict write acknowledgement surfaces queued write failures",
  { skip: !enabled },
  async () => {
    postgresMirror.mirror("forced-integration-failure", async () => {
      throw new Error("forced postgres mirror failure");
    });

    await assert.rejects(
      () => postgresMirror.flushStrict(),
      /forced-integration-failure.*forced postgres mirror failure/
    );

    // Failure is consumed by the strict boundary so a later clean flush does
    // not keep rethrowing stale failures.
    await postgresMirror.flushStrict();
  }
);


test(
  "real Postgres: UsageService recordAsync is visible to the next Postgres quota read before it returns",
  { skip: !enabled },
  async () => {
    const savedReads = process.env.ORVYN_POSTGRES_PRIMARY_READS;
    const savedWrites = process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
    const savedFallback = process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
    const savedQuota = process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;

    process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
    process.env.ORVYN_POSTGRES_PRIMARY_WRITES = "1";
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";
    process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "10";

    const dir = mkdtempSync(join(tmpdir(), "orvyn-usage-ack-"));
    const tenantId = `tenant_usage_ack_${Date.now()}`;
    const store = new LocalStore(tenantId, dir);

    try {
      await postgresMirror.upsertTenant(tenantId, "Usage Ack Test");

      const usage = new UsageService();
      usage.attachStore(store);

      await usage.recordAsync({
        modelId: "ack-model",
        provider: "test",
        method: "generate",
        durationMs: 5,
        ok: true,
      });

      // No manual postgresMirror.flush() here. recordAsync() itself must be the
      // acknowledgement boundary.
      assert.equal(await postgresMirror.countUsageSince(tenantId, 0), 1);
      assert.equal((await usage.quotaAsync()).used, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });

      if (savedReads === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_READS;
      else process.env.ORVYN_POSTGRES_PRIMARY_READS = savedReads;
      if (savedWrites === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
      else process.env.ORVYN_POSTGRES_PRIMARY_WRITES = savedWrites;
      if (savedFallback === undefined) delete process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
      else process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = savedFallback;
      if (savedQuota === undefined) delete process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
      else process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = savedQuota;
    }
  }
);


test(
  "real Postgres: concurrent multi-node registration is globally unique and transactional",
  { skip: !enabled },
  async () => {
    const savedReads = process.env.ORVYN_POSTGRES_PRIMARY_READS;
    const savedWrites = process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
    const savedFallback = process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;

    process.env.ORVYN_POSTGRES_PRIMARY_READS = "1";
    process.env.ORVYN_POSTGRES_PRIMARY_WRITES = "1";
    process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = "0";

    const dirA = mkdtempSync(join(tmpdir(), "orvyn-auth-pg-node-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "orvyn-auth-pg-node-b-"));
    const dirC = mkdtempSync(join(tmpdir(), "orvyn-auth-pg-node-c-"));
    const nodeA = new AuthService(dirA);
    const nodeB = new AuthService(dirB);
    const nodeC = new AuthService(dirC);

    try {
      const suffix = Date.now().toString(36);
      const email = `unique-${suffix}@example.com`;
      const password = "CorrectHorseBatteryStaple!";

      const results = await Promise.allSettled([
        nodeA.registerAsync(email, password, "Node A", {
          accepted: true,
          version: "2026-10-01",
        }),
        nodeB.registerAsync(email, password, "Node B", {
          accepted: true,
          version: "2026-10-01",
        }),
      ]);

      const fulfilled = results.filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<AuthService["registerAsync"]>>> =>
          result.status === "fulfilled"
      );
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );

      assert.equal(fulfilled.length, 1);
      assert.equal(rejected.length, 1);
      assert.match(
        String(rejected[0]?.reason?.message ?? rejected[0]?.reason),
        /already exists/i
      );

      // A third node with an empty SQLite auth cache authenticates using
      // PostgreSQL alone, proving registration + session/account state is
      // globally visible after the winning transaction commits.
      const login = await nodeC.loginAsync(email, password);
      assert.equal(login.user.email, email);
      assert.equal((await nodeC.verifyAsync(login.token))?.id, login.user.id);

      await nodeC.logoutAsync(login.token);
      assert.equal(await nodeC.verifyAsync(login.token), null);
    } finally {
      nodeA.close();
      nodeB.close();
      nodeC.close();
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
      rmSync(dirC, { recursive: true, force: true });

      if (savedReads === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_READS;
      else process.env.ORVYN_POSTGRES_PRIMARY_READS = savedReads;
      if (savedWrites === undefined) delete process.env.ORVYN_POSTGRES_PRIMARY_WRITES;
      else process.env.ORVYN_POSTGRES_PRIMARY_WRITES = savedWrites;
      if (savedFallback === undefined) delete process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE;
      else process.env.ORVYN_POSTGRES_READ_FALLBACK_SQLITE = savedFallback;
    }
  }
);
