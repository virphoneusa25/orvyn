import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyFireworksWriting, FIREWORKS_WRITING_MODEL } from "./fireworksVerification";
import { isRoutineWriting, writingProvider, type ModelConfig } from "@orvyn/ai-core";
import { selectAgentModel, selectImageModel } from "./selectModel";
import { inferTaskIntent } from "../agent/taskIntent";

test("Fireworks exact writing route requires live context/price and a real streaming tool call", async () => {
  const original = globalThis.fetch;
  const config = { id: `fw:${FIREWORKS_WRITING_MODEL}`, apiModelId: FIREWORKS_WRITING_MODEL, apiKey: "fixture-writing", endpoint: "https://fixture.invalid", capabilities: {}, maxOutputTokens: 2048 } as ModelConfig;
  globalThis.fetch = (async (_url, opts) => {
    if (!opts?.method) return new Response('<div>131,072 Context</div><div>$0.22 / $0.66 Per 1M Tokens</div>');
    const body = JSON.parse(String(opts.body)); assert.equal(body.model, FIREWORKS_WRITING_MODEL); assert.equal(body.stream, true);
    return new Response('data: '+JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "probe", function: { name: "capability_probe", arguments: '{"value":"verified"}' } }] }, finish_reason: null }] })+'\n\ndata: '+JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })+'\n\ndata: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
  try { await verifyFireworksWriting(config); } finally { globalThis.fetch = original; }
  assert.equal(config.routingVerification?.status, "verified"); assert.equal(config.rate?.input, .22); assert.equal(config.rate?.output, .66);
  assert.equal(config.contextWindow, 131072); assert.equal(config.capabilities.vision, false);
  const provider = { config } as any;
  assert.ok(isRoutineWriting("Write marketing copy for a newsletter")); assert.equal(isRoutineWriting("Plan a critical marketing strategy"), false);
  assert.equal(writingProvider([provider], { capability: "agent", tools: true, streaming: true }, () => false), undefined);
  const input = { intent: inferTaskIntent("Write routine marketing copy for a newsletter"), availableIds: [config.id], providers: [provider] };
  assert.notEqual(selectAgentModel(input).reason, "Routine writing: verified Fireworks route");
  assert.equal(selectAgentModel({ ...input, requestedModelId: "explicit-user-model" }).registryId, "explicit-user-model");
  config.routingVerification = { status: "failed", reason: "model absent" };
  assert.equal(writingProvider([provider], { capability: "chat" }, () => false), undefined);
});

test("normal or high image quality cannot silently escalate to Max", () => {
  const max = "fw:accounts/fireworks/models/flux-kontext-max";
  const pro = "fw:accounts/fireworks/models/flux-kontext-pro";
  assert.equal(selectImageModel({ quality: "high", availableIds: [pro, max] }).registryId, pro);
  assert.equal(selectImageModel({ availableIds: [max], catalog: [{ registryId: max, generation: true, editing: true }] }).registryId, null);
  assert.equal(selectImageModel({ quality: "premium", availableIds: [max] }).registryId, max);
});

test("an absent Fireworks model page cannot enable the exact route", async () => {
  const original = globalThis.fetch;
  const config = { id: `fw:${FIREWORKS_WRITING_MODEL}`, apiModelId: FIREWORKS_WRITING_MODEL, apiKey: "fixture-absent", endpoint: "https://absent.invalid", capabilities: {} } as ModelConfig;
  globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
  try { await verifyFireworksWriting(config); } finally { globalThis.fetch = original; }
  assert.equal(config.routingVerification?.status, "failed"); assert.match(config.routingVerification!.reason, /HTTP 404/);
  assert.equal(writingProvider([{ config } as any], { capability: "agent", tools: true }, () => false), undefined);
});
