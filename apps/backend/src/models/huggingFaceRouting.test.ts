import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ModelService } from "../services/ModelService";
import { Orchestrator } from "../ai/Orchestrator";
import { inferTaskIntent } from "../agent/taskIntent";
import { selectAgentModel } from "./selectModel";
import { incompatibility, preferHuggingFace } from "@orvyn/ai-core";
import { clearModelAvailability, clearProviderHealth } from "./modelAvailability";
import { verifyHuggingFace } from "./huggingFaceVerification";

const keys = ["HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_BASE_URL", "HUGGINGFACE_MODELS", "HUGGINGFACE_ROUTING_ENABLED", "NEBIUS_BASE_URL", "NEBIUS_API_KEY", "MODEL_API_KEY", "OPENAI_API_KEY", "FIREWORKS_API_KEY", "CHEAPER_INFERENCE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "OLLAMA_MODEL", "ORVYN_DEFAULT_MODEL_PROVIDER"];
const models = ["zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash", "moonshotai/Kimi-K2.7-Code"];
const prices = [[0.9, 4], [0.15, 0.5], [0.68, 3.4]];
const sse = (j: unknown) => `data: ${JSON.stringify(j)}\n\n`;

test("Cloud and Desktop share verified, price-qualified routes and provider-boundary behavior", async (t) => {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let failHF = false, slow = false;
  const calls: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url?.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: models.map((id, i) => ({ id, architecture: { input_modalities: ["text"] }, providers: [{ provider: "deepinfra", status: "live", context_length: 262144, supports_tools: true, pricing: { input: prices[i][0], output: prices[i][1] } }] })) }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ model: body.model, body, url: req.url });
    if (failHF && req.url?.startsWith("/hf")) { res.writeHead(503); res.end("provider temporarily unavailable"); return; }
    res.setHeader("content-type", "text/event-stream");
    const probe = body.tools?.some((tool: any) => tool.function.name === "capability_probe");
    const tool = probe ? [{ index: 0, id: "probe_1", type: "function", function: { name: "capability_probe", arguments: '{"value":"verified"}' } }] : undefined;
    res.write(sse({ choices: [{ delta: tool ? { tool_calls: tool } : { content: "Verified answer" }, finish_reason: tool ? "tool_calls" : null }] }));
    if (slow) { req.on("close", () => res.destroy()); return; }
    res.write(sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 5 } } }));
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    for (const k of keys) delete process.env[k];
    globalThis.fetch = ((input: any, init?: any) => {
      if (String(input).startsWith("https://nebius.com/services/token-factory/models/")) return Promise.resolve(new Response('<h2><span>GLM-5.3</span></h2><li>$1.40 / 1M input tokens · $4.40 / 1M output tokens</li><h2><span>GLM-5.3-Flash</span></h2><li>$0.15 / 1M input tokens · $0.50 / 1M output tokens</li><h2><span>Kimi-K2.7-Code</span></h2><li>$0.95 / 1M input tokens · $4.00 / 1M output tokens</li>'));
      return originalFetch(input, init);
    }) as typeof fetch;
    const unconfigured = new ModelService();
    assert.equal(unconfigured.registry.list().some((p) => p.config.id.startsWith("hf:")), false);
    assert.match(preferHuggingFace(unconfigured.registry.list(), { capability: "chat" }, true, undefined, "flash").reason, /credentials/);
    process.env.HF_TOKEN = "fixture-credential-not-a-real-token";
    process.env.HUGGINGFACE_BASE_URL = `http://127.0.0.1:${port}/hf/v1`;
    process.env.HUGGINGFACE_MODELS = models.map((id) => `${id}:deepinfra`).join(",");
    process.env.HUGGINGFACE_ROUTING_ENABLED = "1";
    process.env.NEBIUS_API_KEY = "fixture-nebius";
    process.env.NEBIUS_BASE_URL = `http://127.0.0.1:${port}/nebius/v1`;
    const service = new ModelService();
    assert.equal(service.registry.get(`hf:${models[0]}:deepinfra`)!.config.capabilities.tools, false);
    await service.huggingFaceReady;
    const providers = service.registry.list();
    assert.equal(calls.length, 0, "constructing tenant services must not run paid inference probes");
    for (const provider of providers.filter(p => p.config.providerName === "huggingface")) {
      assert.equal(provider.config.routingVerification?.status, "failed");
      await verifyHuggingFace(provider.config, { allowPaidProbe: true });
    }
    const hf = service.registry.get(`hf:${models[0]}:deepinfra`)!;
    assert.equal(hf.config.routingVerification?.status, "verified");
    assert.equal(hf.config.contextWindow, 262144);
    assert.equal(hf.config.capabilities.vision, false);
    assert.equal(service.list().find((m) => m.id === hf.config.id)?.apiKey, "configured");
    assert.ok(!JSON.stringify(service.list()).includes("fixture-credential"));
    await t.test("Flash ties preserve Nebius; coding and advanced prefer cheaper verified HF", () => {
      assert.equal(service.router.resolve("chat").config.id, `nebius:${models[1]}`);
      assert.equal(service.router.resolve("agent").config.id, hf.config.id);
      assert.equal(service.router.resolve("code").config.id, `hf:${models[2]}:deepinfra`);
      const choice = selectAgentModel({ intent: inferTaskIntent("Refactor the authentication module across the repository"), requestedModelId: "auto", availableIds: providers.map((p) => p.config.id), providers });
      assert.equal(choice.registryId, `hf:${models[2]}:deepinfra`);
    });
    for (const surface of ["cloud", "desktop"] as const) {
      await t.test(`${surface} Auto uses HF when it is cheaper; explicit selection and telemetry are honored`, async () => {
        // Change the current exact Flash quote to exercise the cheaper route, not a blanket preference.
        const flash = service.registry.get(`hf:${models[1]}:deepinfra`)!;
        flash.config.rate!.input = 0.1;
        const orch = new Orchestrator(service);
        const chunks = [];
        for await (const c of orch.streamChat({ task: "chat", userMessage: "Hello", history: [], surface, requestedModelId: "auto" })) chunks.push(c);
        assert.equal(chunks.find((c) => c.routing)?.routing?.provider, "huggingface");
        assert.equal(chunks.find((c) => c.routing)?.routing?.modelId, flash.config.id);
        const actual = service.usage.recent().find((e) => e.modelId === flash.config.id && e.ok)!;
        assert.equal(actual.provider, "huggingface");
        assert.equal(actual.promptTokens, 20); assert.equal(actual.completionTokens, 0); assert.equal(actual.cachedTokens, 5); assert.equal(actual.estimated, undefined);
        const selected = `nebius:${models[0]}`;
        const pinned = [];
        for await (const c of orch.streamChat({ task: "chat", userMessage: "Hello", history: [], surface, requestedModelId: selected })) pinned.push(c);
        assert.equal(pinned.find((c) => c.routing)?.routing?.modelId, selected);
        assert.equal(selectAgentModel({ intent: inferTaskIntent("Fix code"), requestedModelId: selected, availableIds: providers.map((p) => p.config.id), providers }).registryId, selected);
        flash.config.rate!.input = 0.15;
      });
    }
    await t.test("disabled, failed verification, capability and context exclusions record reasons", () => {
      const needs = { capability: "agent" as const, tools: true, streaming: true };
      assert.match(preferHuggingFace(providers, needs, false, undefined, "advanced").reason, /disabled/);
      assert.equal(incompatibility(hf.config, { ...needs, vision: true }), "vision unsupported");
      assert.equal(incompatibility(hf.config, { ...needs, contextTokens: 300000 }), "context window too small");
      hf.config.routingVerification = { status: "failed", reason: "tool probe failed" };
      const fallback = preferHuggingFace(providers, needs, true, undefined, "advanced");
      assert.equal(fallback.provider?.config.id, `nebius:${models[0]}`);
      assert.match(fallback.reason, /tool probe failed/);
      hf.config.routingVerification = { status: "verified", reason: "fixture" };
      service.router.setOverride("agent", `nebius:${models[0]}`);
      assert.equal(service.router.resolve("agent").config.id, `nebius:${models[0]}`);
      service.router.clearOverride("agent");
    });
    await t.test("fragmented supported tool calls, usage, cancellation and compatible failure fallback", async () => {
      const toolChunks = [];
      for await (const c of hf.stream({ messages: [{ role: "user", content: "Call capability_probe" }], tools: [{ name: "capability_probe", description: "test", parameters: { type: "object" } }], stream: true })) toolChunks.push(c);
      assert.equal(toolChunks.find((c) => c.toolCall)?.toolCall?.arguments.value, "verified");
      slow = true;
      const controller = new AbortController();
      const stream = hf.stream({ messages: [{ role: "user", content: "hello" }], signal: controller.signal, stream: true })[Symbol.asyncIterator]();
      assert.equal((await stream.next()).value.delta, "Verified answer");
      controller.abort();
      await assert.rejects(stream.next(), /abort/i);
      slow = false;
      failHF = true;
      const flash = service.registry.get(`hf:${models[1]}:deepinfra`)!;
      flash.config.rate!.input = 0.1;
      const chunks = [];
      for await (const c of new Orchestrator(service).streamChat({ task: "chat", userMessage: "hello", history: [], requestedModelId: "auto" })) chunks.push(c);
      assert.notEqual(chunks.find((c) => c.routing)?.routing?.provider, "huggingface");
      assert.match(chunks.find((c) => c.routing)?.routing?.reason ?? "", /failure/);
      assert.ok(calls.some((c) => c.model === `${models[2]}:deepinfra`));
    });
  } finally {
    globalThis.fetch = originalFetch;
    clearModelAvailability(); clearProviderHealth();
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
