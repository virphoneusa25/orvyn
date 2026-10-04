// apps/backend/src/persistence/PostgresTenantStore.integration.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import { PostgresTenantStore } from "./PostgresTenantStore";
import type { Mission } from "../agent/TaskEngine";
import type { UsageEvent } from "../services/UsageService";
import type { ModelConfig } from "@orvyn/ai-core";

const url = process.env.ORVYN_POSTGRES_TEST_URL;

test(
  "real Postgres primary store persists and reloads tenant state authoritatively",
  { skip: !url },
  async () => {
    const tenantId = "tenant-primary";
    const otherTenant = "tenant-primary-other";
    const sql = new Pool({ connectionString: url! });

    const store = new PostgresTenantStore(tenantId, url!);
    const other = new PostgresTenantStore(otherTenant, url!);

    try {
      await store.initialize();
      await other.initialize();

      for (const id of [tenantId, otherTenant]) {
        await Promise.all([
          sql.query("DELETE FROM orvyn_missions WHERE tenant_id=$1", [id]),
          sql.query("DELETE FROM orvyn_usage_events WHERE tenant_id=$1", [id]),
          sql.query("DELETE FROM orvyn_settings WHERE tenant_id=$1", [id]),
          sql.query("DELETE FROM orvyn_models WHERE tenant_id=$1", [id]),
        ]);
      }

      const mission: Mission = {
        id: "mission-primary",
        runId: "run-primary",
        projectRoot: "/projects/primary",
        goal: "persist primary state",
        status: "RUNNING",
        tasks: [{
          id: "task_1",
          missionId: "mission-primary",
          description: "write code",
          agent: "coder",
          status: "RUNNING",
          attempts: 1,
          createdAt: 100,
          updatedAt: 110,
        }],
        reviewCycles: 1,
        createdAt: 100,
        updatedAt: 110,
      };
      await store.saveMission(mission);

      const usage: UsageEvent = {
        id: "use-primary",
        timestamp: Date.now(),
        modelId: "primary-model",
        provider: "test",
        method: "generate",
        durationMs: 20,
        ok: true,
        promptTokens: 50,
        completionTokens: 10,
        missionId: mission.id,
      };
      await store.saveUsageEvent(usage);

      await store.setSetting("profile", "AUTONOMOUS");
      await store.setToolOverride("/projects/primary", "terminal", "ask");

      const model: ModelConfig = {
        id: "primary-custom-model",
        name: "Primary Custom Model",
        provider: "openai-compatible",
        endpoint: "https://example.invalid",
        apiKey: "test-key",
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
      await store.saveModel(model);

      // Same object ids in another tenant must not collide.
      await other.saveMission({
        ...mission,
        goal: "isolated tenant",
      });

      // Simulate process/tenant-service reconstruction by opening another
      // logical store against the same PostgreSQL tenant.
      const fresh = new PostgresTenantStore(tenantId, url!);
      await fresh.initialize();

      assert.equal(await fresh.health(), true);

      const missions = await fresh.loadMissions();
      assert.equal(missions.length, 1);
      assert.equal(missions[0]?.goal, "persist primary state");
      assert.equal(missions[0]?.tasks[0]?.status, "RUNNING");

      const recent = await fresh.loadRecentUsage();
      assert.equal(recent.length, 1);
      assert.equal(recent[0]?.id, usage.id);
      assert.equal(recent[0]?.promptTokens, 50);

      assert.equal(await fresh.countUsageSince(usage.timestamp - 1), 1);
      assert.equal(await fresh.countMissionsSince(99), 1);

      assert.equal(await fresh.getSetting("profile"), "AUTONOMOUS");
      assert.deepEqual(
        await fresh.getToolOverrides("/projects/primary"),
        { terminal: "ask" }
      );

      const models = await fresh.loadModels();
      assert.equal(models.length, 1);
      assert.equal(models[0]?.id, model.id);

      const isolated = await other.loadMissions();
      assert.equal(isolated.length, 1);
      assert.equal(isolated[0]?.goal, "isolated tenant");

      await fresh.deleteModel(model.id);
      assert.equal((await fresh.loadModels()).length, 0);
    } finally {
      await sql.end();
    }
  }
);
