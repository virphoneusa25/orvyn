import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../ai/Orchestrator";

for (const surface of ['cloud', 'desktop'] as const) {
  test(`${surface} bounds parallel searches and keeps the latest request in context`, async () => {
    let executed = 0, turns = 0;
    const provider = { config: { id: 'fixture', provider: 'mock', contextWindow: 64000, streaming: true, capabilities: { chat: true, tools: true } }, supportsTools: () => true, supportsVision: () => false,
      async *stream(request: any) {
        turns++;
        assert.ok(request.messages.some((m: any) => m.role === 'system' && m.content.includes('Answer the latest user request: Explain Asterisk VoIP')));
        if (request.tools) {
          for (let i = 0; i < 20; i++) yield { delta: '', done: false, toolCall: { id: `call${i}`, name: 'web_search', arguments: { query: `Asterisk SIP architecture ${i}` } } };
          yield { delta: '', done: true };
        } else yield { delta: 'Asterisk is an open-source telephony platform.', done: true };
      } };
    const service = { huggingFaceReady: Promise.resolve(), registry: { list: () => [provider], get: () => provider }, router: { preferred: () => ({ provider, reason: 'fixture' }), getExplicitOverrides: () => ({}), resolve: () => provider } } as any;
    const webTools = { execute: async () => { executed++; return { ok: true, output: 'Asterisk official documentation describes PBX, SIP, and dialplans.' }; } };
    const chunks = [];
    for await (const chunk of new Orchestrator(service, undefined, undefined, undefined, webTools).streamChat({ task: 'chat', history: [{ role: 'user', content: 'Tell me about VirPhone' }], userMessage: 'Explain Asterisk VoIP', surface })) chunks.push(chunk);
    assert.equal(executed, 12); assert.equal(turns, 2);
    assert.ok(chunks.some((c) => c.delta.includes('Asterisk is')));
  });
  test(`${surface} duplicate searches do not execute twice`, async () => {
    let executed = 0, turns = 0;
    const provider = { config: { id: 'fixture', provider: 'mock', contextWindow: 64000, streaming: true, capabilities: { chat: true, tools: true } }, supportsTools: () => true, supportsVision: () => false,
      async *stream() {
        turns++;
        if (turns === 1) {
          for (const [i, query] of ['Asterisk SIP', 'ASTERISK: SIP!'].entries()) yield { delta: '', done: false, toolCall: { id: `call${i}`, name: 'web_search', arguments: { query } } };
          yield { delta: '', done: true };
        } else yield { delta: 'Asterisk supports SIP.', done: true };
      } };
    const service = { huggingFaceReady: Promise.resolve(), registry: { list: () => [provider], get: () => provider }, router: { preferred: () => ({ provider, reason: 'fixture' }), getExplicitOverrides: () => ({}), resolve: () => provider } } as any;
    for await (const _ of new Orchestrator(service, undefined, undefined, undefined, { execute: async () => { executed++; return { ok: true, output: 'Official Asterisk documentation.' }; } }).streamChat({ task: 'chat', history: [], userMessage: 'Explain Asterisk VoIP', surface })) { /* drain */ }
    assert.equal(executed, 1);
  });
}
