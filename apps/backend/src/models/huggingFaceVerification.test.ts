import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModelConfig } from "@orvyn/ai-core";
import { verifyHuggingFace } from "./huggingFaceVerification";

test("transient HF capability failures retry and do not poison subsequent sessions", async () => {
  const original = globalThis.fetch;
  let failures = 1, calls = 0;
  globalThis.fetch = (async (url) => {
    calls++;
    if (String(url).endsWith('/models')) {
      if (failures-- > 0) return new Response('', { status: 503 });
      return Response.json({ data: [{ id: 'fixture/model', architecture: { input_modalities: ['text'] }, providers: [{ provider: 'deepinfra', status: 'live', context_length: 65536, supports_tools: true, pricing: { input: .1, output: .2 } }] }] });
    }
    return new Response('data: '+JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe', function: { name: 'capability_probe', arguments: '{"value":"verified"}' } }] }, finish_reason: 'tool_calls' }] })+'\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  const config = (key: string) => ({ id: 'hf:fixture/model:deepinfra', apiModelId: 'fixture/model:deepinfra', endpoint: 'https://hf-probe.fixture.invalid', apiKey: key, maxOutputTokens: 2048, capabilities: { chat: false, code: false, tools: false } } as ModelConfig);
  try {
    const recovering = config('transient');
    await verifyHuggingFace(recovering, { allowPaidProbe: true });
    assert.equal(recovering.routingVerification?.status, 'verified');
    assert.equal(calls, 3);
    const failed = config('initially-unavailable'); failures = 2;
    await verifyHuggingFace(failed, { allowPaidProbe: true });
    assert.equal(failed.routingVerification?.status, 'failed');
    assert.equal(failed.capabilities.tools, false);
    const nextSession = config('initially-unavailable'); failures = 0;
    await verifyHuggingFace(nextSession, { allowPaidProbe: true });
    assert.equal(nextSession.routingVerification?.status, 'verified');
    assert.equal(nextSession.capabilities.tools, true);
  } finally { globalThis.fetch = original; }
});