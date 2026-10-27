import { test } from "node:test";
import assert from "node:assert/strict";
import type { AIModelProvider, ModelConfig } from "@orvyn/ai-core";
import { verifyHuggingFace, inspectHuggingFace } from "./huggingFaceVerification";
import { meteredProviderProbe } from "./MeteredProviderProbe";

const base = (key = "fixture") => ({
  id: "hf:fixture/model:deepinfra",
  apiModelId: "fixture/model:deepinfra",
  endpoint: "https://hf-probe.fixture.invalid",
  apiKey: key,
  maxOutputTokens: 2048,
  capabilities: { chat: false, code: false, agent: false, tools: false, vision: false, completion: false },
} as ModelConfig);

const listing = {
  data: [{
    id: "fixture/model",
    architecture: { input_modalities: ["text"] },
    providers: [{ provider: "deepinfra", status: "live", context_length: 65536, supports_tools: true, pricing: { input: 0.1, output: 0.2 } }],
  }],
};

test("automatic HF refresh stays unverified and never makes a paid request", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("Unexpected request"); }) as typeof fetch;
  try {
    const config = base();
    await verifyHuggingFace(config);
    assert.equal(config.routingVerification?.status, "unverified");
    assert.equal(config.capabilities.tools, false);
    assert.equal(requests, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("authorized metered verification records bounded usage and persistent evidence before enabling the route", async () => {
  const original = globalThis.fetch;
  let reservation = 0, paidCalls = 0, savedAttempt = "";
  globalThis.fetch = (async () => Response.json(listing)) as typeof fetch;
  const fakeStore = {
    reserve: async (_config: ModelConfig, micros: number) => { reservation = micros; return "attempt-1"; },
    settle: async (id: string, cost: number | undefined, usage: any) => {
      assert.equal(id, "attempt-1");
      assert.equal(cost, 2);
      assert.equal(usage.promptTokens, 10);
    },
  };
  const fakeAdapter = (_config: ModelConfig): Pick<AIModelProvider, "stream"> => ({
    async *stream(request: any) {
      paidCalls++;
      assert.equal(request.maxOutputTokens, 128);
      assert.equal(request.messages.length, 1);
      assert.equal(request.messages[0].images, undefined);
      yield { delta: "", toolCall: { id: "probe-1", name: "capability_probe", arguments: { value: "verified" } }, done: false };
      yield { delta: "", done: true, usage: { promptTokens: 10, completionTokens: 1 } };
    },
  });
  try {
    const config = base();
    const probe = meteredProviderProbe(fakeStore, fakeAdapter, 10_000);
    await verifyHuggingFace(config, { meteredProbe: probe, verificationStore: { save: async (_config, id) => { savedAttempt = id; } } });
    assert.equal(config.routingVerification?.status, "verified");
    assert.equal(config.capabilities.tools, true);
    assert.equal(config.capabilities.vision, false);
    assert.equal(savedAttempt, "attempt-1");
    assert.equal(probe.successfulAttempt, "attempt-1");
    assert.equal(probe.result?.usage.promptTokens, 10);
    assert.ok(reservation > 0 && reservation <= 10_000);
    assert.equal(paidCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("catalog results distinguish missing credentials, unsupported routes, and provider outages", async () => {
  const original = globalThis.fetch;
  try {
    const outcomes: Array<[number, string]> = [[401, "credentials_unavailable"], [404, "unsupported"], [503, "provider_outage"]];
    for (const [http, expected] of outcomes) {
      globalThis.fetch = (async () => new Response("", { status: http })) as typeof fetch;
      assert.equal((await inspectHuggingFace(base())).status, expected);
    }
    globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;
    assert.equal((await inspectHuggingFace(base())).status, "unsupported");
    globalThis.fetch = (async () => Response.json(listing)) as typeof fetch;
    assert.equal((await inspectHuggingFace(base())).status, "available");
  } finally {
    globalThis.fetch = original;
  }
});

test("an unsupported capability never reaches the paid probe", async () => {
  const original = globalThis.fetch;
  let paidCalls = 0;
  globalThis.fetch = (async () => Response.json({
    data: [{ id: "fixture/model", providers: [{ provider: "deepinfra", status: "live", context_length: 65536, supports_tools: false, pricing: { input: 0.1, output: 0.2 } }] }],
  })) as typeof fetch;
  const probe = meteredProviderProbe({ reserve: async () => { paidCalls++; return "bad"; }, settle: async () => {} }, () => ({ async *stream() {} }), 10_000);
  try {
    const config = base();
    await verifyHuggingFace(config, { meteredProbe: probe, verificationStore: { save: async () => {} } });
    assert.equal(config.routingVerification?.status, "unsupported");
    assert.equal(config.capabilities.tools, false);
    assert.equal(paidCalls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
