import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPublicModelEndpoint, customerCatalog, customerNameFor, redactForCustomer, resolveCustomerModel } from "./customerCatalog";
import { selectAgentModel } from "./selectModel";

const IDS = new Set(["fw:accounts/fireworks/models/glm-5p3", "ci:gpt-5.6-luna", "nebius:zai-org/GLM-5.3-Flash", "orvyn-mock"]);

test("run events lose vendor identity; the conversation is untouched", () => {
  const event = {
    type: "model.failover",
    data: {
      modelId: "fw:accounts/fireworks/models/glm-5p3",
      to: "ci:gpt-5.6-luna",
      provider: "fireworks",
      endpoint: "https://api.fireworks.ai/inference",
      reason: "Fireworks returned 429 from https://api.fireworks.ai/inference/v1",
      content: "Compare OpenAI and Anthropic pricing for me.",
      delta: "OpenAI charges per token; Claude is by Anthropic.",
    },
  };
  const out = redactForCustomer(event, IDS) as any;
  assert.equal(out.data.modelId, "ORVYN Auto");
  assert.equal(out.data.to, "ORVYN Fast");
  assert.equal(out.data.provider, "ORVYN");
  assert.equal(out.data.endpoint, undefined);
  assert.doesNotMatch(out.data.reason, /fireworks/i);
  assert.equal(out.data.content, event.data.content, "what the user wrote is kept");
  assert.equal(out.data.delta, event.data.delta, "what ORION wrote is kept");
  assert.doesNotMatch(JSON.stringify(out).replace(event.data.content, "").replace(event.data.delta, ""), /fireworks|nebius|cheaperinference|gpt-5\.6/i);
});

test("a customer's own model is shown as they entered it, without its key", () => {
  const out = redactForCustomer({ models: [{ id: "my:llama", kind: "user", provider: "openai-compatible", endpoint: "https://api.together.xyz", apiKey: "sk-secret" }] }, IDS) as any;
  assert.equal(out.models[0].endpoint, "https://api.together.xyz");
  assert.equal(out.models[0].apiKey, undefined);
});

test("customer model names never reveal a vendor", () => {
  for (const id of IDS) assert.match(customerNameFor(id), /^ORVYN/);
});

test("the catalog is six ORVYN models, and routing never lands on a customer's own model", () => {
  const view = [
    { id: "ci:gpt-5.6-luna", vision: true, chat: true, mock: false },
    { id: "nebius:zai-org/GLM-5.3-Flash", vision: false, chat: true, mock: false },
    { id: "my:cheap", vision: true, chat: true, mock: false },
  ];
  assert.deepEqual(customerCatalog(view).map((m) => m.name), ["Auto", "Fast", "Reasoning", "Code", "Research", "Vision"]);
  assert.equal(resolveCustomerModel("vision", view), "ci:gpt-5.6-luna");
  const fast = selectAgentModel({ intent: { category: "general", informational: true, requiresFrontend: false, goal: "hi" } as any, requestedModelId: "fast", availableIds: ["ci:gpt-5.6-luna"] });
  assert.equal(fast.pinned, false);
  assert.equal(fast.registryId, "ci:gpt-5.6-luna");
  const reasoning = selectAgentModel({ intent: { category: "general", informational: true, requiresFrontend: false, goal: "why" } as any, requestedModelId: "reasoning", availableIds: ["nebius:deepseek-ai/DeepSeek-V4-Pro"] });
  assert.equal(reasoning.registryId, "nebius:deepseek-ai/DeepSeek-V4-Pro");
  const own = selectAgentModel({ intent: { category: "general", informational: false, requiresFrontend: false, goal: "x" } as any, requestedModelId: "my:cheap", availableIds: ["ci:gpt-5.6-luna"] });
  assert.equal(own.pinned, true);
  assert.equal(own.registryId, "my:cheap");
});

test("Vision prefers an explicitly deployed Fireworks Qwen3-VL model over Gemini", () => {
  const view = [
    { id: "ci:google/gemini-3.5-flash-lite", vision: true, chat: true, mock: false },
    { id: "fw:accounts/fireworks/models/qwen3-vl-30b-a3b-instruct", vision: true, chat: true, mock: false },
  ];
  assert.equal(resolveCustomerModel("vision", view), "fw:accounts/fireworks/models/qwen3-vl-30b-a3b-instruct");
});

test("a customer's model endpoint must be public https", async () => {
  const dns = (map: Record<string, string[]>) => async (h: string) => map[h] ?? [];
  await assert.rejects(assertPublicModelEndpoint("http://api.example.com/v1", dns({ "api.example.com": ["93.184.216.34"] })), /https/);
  await assert.rejects(assertPublicModelEndpoint("https://localhost/v1"), /isn't reachable/);
  await assert.rejects(assertPublicModelEndpoint("https://169.254.169.254/latest"), /isn't reachable/);
  await assert.rejects(assertPublicModelEndpoint("https://10.0.0.5/v1"), /isn't reachable/);
  await assert.rejects(assertPublicModelEndpoint("https://[::1]/v1"), /isn't reachable/);
  await assert.rejects(assertPublicModelEndpoint("https://rebind.example/v1", dns({ "rebind.example": ["93.184.216.34", "127.0.0.1"] })), /isn't reachable/);
  await assert.rejects(assertPublicModelEndpoint("https://user:pw@api.example.com/v1"), /key field/);
  const ok = await assertPublicModelEndpoint("https://api.example.com/v1", dns({ "api.example.com": ["93.184.216.34"] }));
  assert.equal(ok.hostname, "api.example.com");
});

test("usage keyed by model or provider is re-keyed under ORVYN names and merged", () => {
  const stats = { providers: { fireworks: 100, nebius: 50 }, days: [{ day: "2026-09-29", models: { "fw:accounts/fireworks/models/glm-5p3": { credits: 3, tokens: 10 }, "ci:gpt-5.6-luna": { credits: 1, tokens: 5 }, "my:mine": { credits: 0, tokens: 7 } } }] };
  const out = redactForCustomer(stats, IDS) as any;
  assert.deepEqual(out.providers, { ORVYN: 150 });
  assert.deepEqual(Object.keys(out.days[0].models).sort(), ["ORVYN Auto", "ORVYN Fast", "my:mine"]);
  assert.doesNotMatch(JSON.stringify(out), /fireworks|nebius|gpt-5/i);
});

test("customer routing hides serving identity while internal telemetry remains intact", () => {
  const routing = { provider: "huggingface", modelId: "hf:zai-org/GLM-5.3:deepinfra", reason: "Verified cheaper equivalent", apiKey: "fixture-private", endpoint: "https://private.test" };
  const redacted = redactForCustomer({ routing, apiKey: "fixture-private" }, IDS);
  assert.equal(redacted.routing.provider, "ORVYN");
  assert.match(redacted.routing.modelId, /^ORVYN/);
  assert.equal(routing.provider, "huggingface", "internal telemetry is not mutated");
  assert.equal(redacted.routing.reason, "Automatic model selection");
  assert.doesNotMatch(JSON.stringify(redacted), /huggingface|deepinfra|GLM|zai-org/i);
  assert.ok(!JSON.stringify(redacted).includes("fixture-private"));
  assert.ok(!JSON.stringify(redacted).includes("private.test"));
});

test("nested live/history routing and HF diagnostics never reveal platform identities", () => {
  const routing = { provider: "nebius", modelId: "nebius:zai-org/GLM-5.3-Flash", reason: "Nebius price tie; Hugging Face DeepInfra unavailable" };
  const result = redactForCustomer({events:[{data:{routing}}],messages:[{meta:{routing}}],reason:"Hugging Face failed at https://router.huggingface.co/v1/models",providers:{huggingface:2,deepinfra:3}}, IDS);
  assert.doesNotMatch(JSON.stringify(result), /nebius|hugging ?face|deepinfra|zai-org|GLM|router\./i);
  assert.deepEqual(result.providers, {ORVYN:5});
  assert.equal(routing.provider,"nebius");
});
