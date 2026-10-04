// apps/backend/src/persistence/PostgresShadowStore.integration.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { PostgresShadowStore } from "./PostgresShadowStore";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import type { ModelConfig } from "@orvyn/ai-core";
import { LocalStore } from "./LocalStore";
import { backfillTenant, compareTenantParity } from "./PostgresBackfill";
import { readSQLiteTenantSnapshot } from "./SQLiteSnapshot";

const url = process.env.ORVYN_POSTGRES_TEST_URL;

test(
  "real Postgres: shadow store mirrors and upserts tenant data without collisions",
  { skip: !url },
  async () => {
    const shadow = new PostgresShadowStore(url!);
    const sql = new Pool({ connectionString: url! });

    try {
      assert.equal(await shadow.ping(), true);

      await sql.query("TRUNCATE orvyn_missions, orvyn_usage_events, orvyn_settings, orvyn_models");

      const mission: Mission = {
        id: "mission_pg_1",
        runId: "run_pg_1",
        projectRoot: "/projects/pg",
        goal: "verify postgres shadow",
        status: "RUNNING",
        tasks: [],
        reviewCycles: 0,
        createdAt: 100,
        updatedAt: 100,
      };

      shadow.mirrorMission("tenant-a", mission);
      shadow.mirrorMission("tenant-b", { ...mission, goal: "tenant isolation" });

      const usage: UsageEvent = {
        id: "use_pg_1",
        timestamp: 200,
        modelId: "model-a",
        provider: "test",
        method: "generate",
        durationMs: 12,
        ok: true,
        promptTokens: 10,
        completionTokens: 5,
        missionId: mission.id,
      };
      shadow.mirrorUsageEvent("tenant-a", usage);
      shadow.mirrorUsageEvent("tenant-a", usage); // idempotent duplicate

      shadow.mirrorSetting("tenant-a", "profile", "BALANCED");
      shadow.mirrorSetting("tenant-a", "profile", "AUTONOMOUS");

      const model: ModelConfig = {
        id: "pg-model",
        name: "PG Model",
        provider: "openai-compatible",
        endpoint: "https://example.invalid",
        apiKey: "test",
        contextWindow: 8192,
        maxOutputTokens: 2048,
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

      shadow.mirrorModel("tenant-a", model);
      await shadow.flush();

      const missionRows = await sql.query(
        "SELECT tenant_id, goal, status FROM orvyn_missions WHERE id = $1 ORDER BY tenant_id",
        [mission.id]
      );
      assert.deepEqual(
        missionRows.rows.map((r) => [r.tenant_id, r.goal]),
        [
          ["tenant-a", "verify postgres shadow"],
          ["tenant-b", "tenant isolation"],
        ]
      );

      mission.status = "COMPLETED";
      mission.updatedAt = 300;
      mission.tasks.push({
        id: "task_1",
        missionId: mission.id,
        description: "finish",
        agent: "coder",
        status: "COMPLETED",
        attempts: 1,
        createdAt: 100,
        updatedAt: 300,
      });
      shadow.mirrorMission("tenant-a", mission);
      await shadow.flush();

      const completed = await sql.query(
        "SELECT status, updated_at, tasks_json FROM orvyn_missions WHERE tenant_id=$1 AND id=$2",
        ["tenant-a", mission.id]
      );
      assert.equal(completed.rows[0]?.status, "COMPLETED");
      assert.equal(Number(completed.rows[0]?.updated_at), 300);
      assert.equal(completed.rows[0]?.tasks_json?.[0]?.status, "COMPLETED");

      const usageCount = await sql.query(
        "SELECT COUNT(*)::int AS n FROM orvyn_usage_events WHERE tenant_id=$1 AND id=$2",
        ["tenant-a", usage.id]
      );
      assert.equal(usageCount.rows[0]?.n, 1);

      const setting = await sql.query(
        "SELECT value FROM orvyn_settings WHERE tenant_id=$1 AND key=$2",
        ["tenant-a", "profile"]
      );
      assert.equal(setting.rows[0]?.value, "AUTONOMOUS");

      const modelRow = await sql.query(
        "SELECT config_json FROM orvyn_models WHERE tenant_id=$1 AND id=$2",
        ["tenant-a", model.id]
      );
      assert.equal(modelRow.rows[0]?.config_json?.id, "pg-model");

      shadow.deleteModel("tenant-a", model.id);
      await shadow.flush();

      const modelCount = await sql.query(
        "SELECT COUNT(*)::int AS n FROM orvyn_models WHERE tenant_id=$1 AND id=$2",
        ["tenant-a", model.id]
      );
      assert.equal(modelCount.rows[0]?.n, 0);

      assert.equal(shadow.status().failures, 0);
      assert.equal(shadow.status().pendingWrites, 0);
    } finally {
      await shadow.close();
      await sql.end();
    }
  }
);


test(
  "real SQLite + Postgres: tenant backfill reaches count parity end-to-end",
  { skip: !url },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "orvyn-pg-backfill-"));
    const tenantId = "tenant-backfill";
    const local = new LocalStore(tenantId, dir);
    const shadow = new PostgresShadowStore(url!);
    const sql = new Pool({ connectionString: url! });

    try {
      await shadow.ping();
      await Promise.all([
        sql.query("DELETE FROM orvyn_missions WHERE tenant_id=$1", [tenantId]),
        sql.query("DELETE FROM orvyn_usage_events WHERE tenant_id=$1", [tenantId]),
        sql.query("DELETE FROM orvyn_settings WHERE tenant_id=$1", [tenantId]),
        sql.query("DELETE FROM orvyn_models WHERE tenant_id=$1", [tenantId]),
      ]);

      local.saveMission({
        id: "mission_backfill",
        runId: "run_backfill",
        projectRoot: "/projects/backfill",
        goal: "backfill",
        status: "COMPLETED",
        tasks: [],
        reviewCycles: 0,
        createdAt: 10,
        updatedAt: 20,
      });
      local.saveUsageEvent({
        id: "use_backfill",
        timestamp: 30,
        modelId: "model-backfill",
        provider: "test",
        method: "generate",
        durationMs: 1,
        ok: true,
      });
      local.setSetting("profile", "SAFE");
      local.saveModel({
        id: "backfill-model",
        name: "Backfill Model",
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
          code: false,
          agent: false,
          tools: false,
          vision: false,
          embeddings: false,
          completion: true,
          image: false,
        },
      });

      local.close();

      const snapshot = readSQLiteTenantSnapshot(tenantId, dir);
      assert.deepEqual(
        {
          missions: snapshot.missions.length,
          usage: snapshot.usage.length,
          settings: snapshot.settings.length,
          models: snapshot.models.length,
        },
        { missions: 1, usage: 1, settings: 1, models: 1 }
      );

      await backfillTenant(shadow, snapshot);
      const parity = await compareTenantParity(sql, snapshot);

      assert.equal(parity.matches, true);
      assert.deepEqual(parity.sqlite, parity.postgres);
    } finally {
      try { local.close(); } catch {}
      await shadow.close();
      await sql.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
