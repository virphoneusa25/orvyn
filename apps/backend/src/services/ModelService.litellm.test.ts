// apps/backend/src/services/ModelService.litellm.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { ModelService } from "./ModelService";

const KEYS = [
  "ORVYN_LITELLM_ENABLED",
  "MODEL_ROUTER_URL",
  "MODEL_ROUTER_KEY",
  "LITELLM_MASTER_KEY",
  "MODEL_API_KEY",
  "OPENAI_MODEL",
  "OPENAI_CODE_MODEL",
  "CHEAPER_INFERENCE_API_KEY",
  "OLLAMA_MODEL",
  "DEEPSEEK_API_KEY",
  "ASTRA_MODEL_ID",
  "ORCHESTRATOR_MODEL",
] as const;

function withEnv(values: Partial<Record<(typeof KEYS)[number], string>>, fn: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value !== undefined) process.env[key] = value;
    }
    fn();
  } finally {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("LiteLLM registers abstract tiers and becomes the text/agent default when enabled", () => {
  withEnv(
    {
      ORVYN_LITELLM_ENABLED: "1",
      MODEL_ROUTER_URL: "http://router.internal:4000/v1/",
      MODEL_ROUTER_KEY: "sk-test-router",
    },
    () => {
      const service = new ModelService();

      const fast = service.registry.get("litellm:fast-tier");
      const code = service.registry.get("litellm:code-tier");
      const premium = service.registry.get("litellm:premium-tier");

      assert.ok(fast);
      assert.ok(code);
      assert.ok(premium);

      // OpenAICompatibleAdapter appends /v1 itself, so ModelService must
      // normalize a user-supplied /v1 URL back to the proxy root.
      assert.equal(fast.config.endpoint, "http://router.internal:4000");
      assert.equal(fast.config.apiModelId, "fast-tier");
      assert.equal(code.config.apiModelId, "code-tier");
      assert.equal(premium.config.apiModelId, "premium-tier");

      assert.equal(service.router.resolve("chat").config.id, "litellm:fast-tier");
      assert.equal(service.router.resolve("completion").config.id, "litellm:fast-tier");
      assert.equal(service.router.resolve("code").config.id, "litellm:code-tier");
      assert.equal(service.router.resolve("agent").config.id, "litellm:code-tier");
      assert.equal(service.router.resolve("executor").config.id, "litellm:code-tier");
      assert.equal(service.router.resolve("planner").config.id, "litellm:premium-tier");
      assert.equal(service.router.resolve("reviewer").config.id, "litellm:premium-tier");
    }
  );
});

test("LiteLLM stays disabled unless explicitly enabled", () => {
  withEnv(
    {
      MODEL_ROUTER_URL: "http://router.internal:4000",
      MODEL_ROUTER_KEY: "sk-test-router",
    },
    () => {
      const service = new ModelService();
      assert.equal(service.registry.get("litellm:fast-tier"), undefined);
      assert.equal(service.router.resolve("chat").config.id, "orvyn-mock");
    }
  );
});

test("direct providers remain registered as rollback options when LiteLLM is enabled", () => {
  withEnv(
    {
      ORVYN_LITELLM_ENABLED: "1",
      MODEL_ROUTER_URL: "http://router.internal:4000",
      MODEL_ROUTER_KEY: "sk-test-router",
      MODEL_API_KEY: "sk-test-direct",
      OPENAI_MODEL: "direct-chat",
      OPENAI_CODE_MODEL: "direct-code",
    },
    () => {
      const service = new ModelService();

      assert.ok(service.registry.get("direct-chat"));
      assert.ok(service.registry.get("direct-code"));
      assert.ok(service.registry.get("litellm:fast-tier"));
      assert.ok(service.registry.get("litellm:code-tier"));

      // LiteLLM wins only as the default route; direct providers remain
      // addressable for manual overrides and emergency rollback.
      assert.equal(service.router.resolve("chat").config.id, "litellm:fast-tier");
      assert.equal(service.router.resolve("executor").config.id, "litellm:code-tier");

      service.router.setOverride("chat", "direct-chat");
      assert.equal(service.router.resolve("chat").config.id, "direct-chat");
    }
  );
});
