import { test } from "node:test";
import assert from "node:assert/strict";
import { ModelService } from "../services/ModelService";

const envKeys = [
  "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_BASE_URL", "HUGGINGFACE_MODELS", "HUGGINGFACE_ROUTING_ENABLED",
  "MODEL_API_KEY", "OPENAI_API_KEY", "FIREWORKS_API_KEY", "NEBIUS_API_KEY", "CHEAPER_INFERENCE_API_KEY",
  "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY",
] as const;

test("Hugging Face routes register only with a server key and preserve the provider-qualified model id", async () => {
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  try {
    for (const key of envKeys) delete process.env[key];
    const withoutKey = new ModelService();
    assert.equal(withoutKey.registry.get("hf:zai-org/GLM-5.3:deepinfra"), undefined);

    process.env.HUGGINGFACE_API_KEY = "hf_test_server_secret";
    process.env.HUGGINGFACE_BASE_URL = "https://router.huggingface.co/v1";
    process.env.HUGGINGFACE_MODELS = "zai-org/GLM-5.3:deepinfra";
    const withKey = new ModelService();
    const model = withKey.registry.get("hf:zai-org/GLM-5.3:deepinfra")?.config;

    assert.ok(model);
    assert.equal(model.apiKey, "hf_test_server_secret");
    assert.equal(model.endpoint, "https://router.huggingface.co");
    assert.equal(model.apiModelId, "zai-org/GLM-5.3:deepinfra");
    assert.equal(model.provider, "openai-compatible");
    assert.equal(model.streaming, true);
    assert.equal(model.capabilities.tools, true);

    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    let requestedAuthorization = "";
    let requestedModel = "";
    let requestedTools: any[] = [];
    globalThis.fetch = (async (input, init) => {
      requestedUrl = String(input);
      requestedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
      const body = JSON.parse(String(init?.body));
      requestedModel = body.model;
      requestedTools = body.tools ?? [];
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok", tool_calls: [{ id: "call_hf", type: "function", function: { name: "read_file", arguments: '{"path":"README.md"}' } }] }, finish_reason: "tool_calls" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const provider = withKey.registry.get("hf:zai-org/GLM-5.3:deepinfra")!;
      const response = await provider.generate({ messages: [{ role: "user", content: "Read README.md" }], tools: [{ name: "read_file", description: "Read a project file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
      assert.equal(response.content, "ok");
      assert.equal(response.toolCalls?.[0]?.name, "read_file");
      assert.deepEqual(response.toolCalls?.[0]?.arguments, { path: "README.md" });
      assert.equal(requestedUrl, "https://router.huggingface.co/v1/chat/completions");
      assert.equal(requestedAuthorization, "Bearer hf_test_server_secret");
      assert.equal(requestedModel, "zai-org/GLM-5.3:deepinfra");
      assert.equal(requestedTools[0]?.function?.name, "read_file");
    } finally {
      globalThis.fetch = originalFetch;
    }

    delete process.env.HUGGINGFACE_API_KEY;
    process.env.HF_TOKEN = "hf_test_alias";
    assert.equal(new ModelService().registry.get("hf:zai-org/GLM-5.3:deepinfra")?.config.apiKey, "hf_test_alias");
  } finally {
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
