// apps/backend/src/persistence/PostgresMirror.integration.test.ts
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ModelConfig } from "@orvyn/ai-core";
import { LocalStore } from "./LocalStore";
import { postgresMirror } from "./PostgresMirror";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";

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
