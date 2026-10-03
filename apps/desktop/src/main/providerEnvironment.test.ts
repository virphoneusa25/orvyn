import { test } from "node:test";
import assert from "node:assert/strict";
import { captureProviderCredentials } from "./providerEnvironment.ts";

test("Desktop retains runtime credentials for its backend and removes them from renderer/worker inheritance", () => {
  const env: Record<string, string | undefined> = { HUGGINGFACE_API_KEY: "fixture-key", HF_TOKEN: "fixture-alias", HUGGINGFACE_ROUTING_ENABLED: "1", HUGGINGFACE_MODELS: "fixture-model", PATH: "fixture-path" };
  const backend = captureProviderCredentials(env);
  assert.deepEqual(backend, { HUGGINGFACE_API_KEY: "fixture-key", HF_TOKEN: "fixture-alias" });
  assert.equal(env.HUGGINGFACE_API_KEY, undefined); assert.equal(env.HF_TOKEN, undefined);
  assert.equal(env.HUGGINGFACE_ROUTING_ENABLED, "1"); assert.equal(env.PATH, "fixture-path");
  assert.ok(!JSON.stringify(env).includes("fixture-key"));
});
