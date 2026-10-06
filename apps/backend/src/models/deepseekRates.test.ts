import { test } from "node:test";
import assert from "node:assert/strict";
import { deepSeekPeak, parseDeepSeekPrices, refreshDeepSeekRates } from "./deepseekRates";
import { writingProvider, incompatibility, type ModelConfig } from "@orvyn/ai-core";

const table = '<table><tr><td>MODEL</td><td>deepseek-flash<sup>(1)</sup></td><td>deepseek-v4-pro</td></tr>' +
  [['PRICING', '1M INPUT TOKENS (CACHE HIT)', 'OFF-PEAK', '$0.003', '$0.022'], ['PEAK', '$0.006', '$0.044'], ['1M INPUT TOKENS (CACHE MISS)', 'OFF-PEAK', '$0.15', '$0.66'], ['PEAK', '$0.3', '$1.32'], ['1M OUTPUT TOKENS', 'OFF-PEAK', '$0.6', '$1.98'], ['PEAK', '$1.2', '$3.96']].map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') + '</table>Peak hours 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays.';

test("DeepSeek prices preserve exact cached, fresh, output and model columns", () => {
  const prices = parseDeepSeekPrices(table);
  assert.deepEqual(prices['deepseek-flash'].offPeak, { input: .15, cachedInput: .003, output: .6 });
  assert.deepEqual(prices['deepseek-v4-pro'].peak, { input: 1.32, cachedInput: .044, output: 3.96 });
  assert.throws(() => parseDeepSeekPrices(table.replace('deepseek-flash<sup>', 'other<sup>')), /columns changed/);
  assert.throws(() => parseDeepSeekPrices(table.replace('$0.003', '$unknown')), /price unavailable/);
});
test("DeepSeek UTC peak boundaries respect weekdays and official Chinese holidays", () => {
  const peak = (s: string) => deepSeekPeak(Date.parse(s));
  assert.equal(peak('2026-10-08T00:59:59Z'), false);
  assert.equal(peak('2026-10-08T01:00:00Z'), true);
  assert.equal(peak('2026-10-08T04:00:00Z'), false);
  assert.equal(peak('2026-10-08T06:00:00Z'), true);
  assert.equal(peak('2026-10-08T10:00:00Z'), false);
  assert.equal(peak('2026-10-05T02:00:00Z'), false);
  assert.equal(peak('2026-10-10T02:00:00Z'), false);
  assert.throws(() => peak('2027-01-04T02:00:00Z'), /calendar needs updating/);
});
test("direct DeepSeek writing requires a real streaming tool call and a current quote", async () => {
  const original = globalThis.fetch;
  const config = { id: 'deepseek-flash', providerName: 'deepseek', provider: 'openai-compatible', apiKey: 'fixture', endpoint: 'https://api.deepseek.com', contextWindow: 128000, streaming: true, capabilities: { agent: true, chat: true, tools: true, vision: false }, maxOutputTokens: 2048 } as ModelConfig;
  globalThis.fetch = (async (_url, opts) => opts?.method ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'probe', function: { name: 'capability_probe', arguments: '{"value":"verified"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n') : new Response(table)) as typeof fetch;
  try { await refreshDeepSeekRates(config); } finally { globalThis.fetch = original; }
  assert.equal(config.routingVerification?.status, 'verified');
  assert.equal(config.contextWindow, 1_000_000);
  assert.ok(config.rate?.expiresAt && config.rate.expiresAt > Date.now());
  const provider = { config } as any;
  assert.equal(writingProvider([provider], { capability: 'agent', tools: true }, () => false), provider);
  assert.equal(writingProvider([provider], { capability: 'agent', vision: true }, () => false), undefined);
  assert.match(incompatibility({ ...config, billingRequired: true, rate: undefined }, { capability: 'chat' })!, /billing rate/);
});

test("unfunded DeepSeek exposes a safe actionable reason and verifies again after funding",async()=>{
  const original=globalThis.fetch;
  const config={id:'deepseek-flash',providerName:'deepseek',provider:'openai-compatible',apiKey:'fixture-funding-recovery',endpoint:'https://api.deepseek.com',contextWindow:128000,streaming:true,capabilities:{agent:true,chat:true,tools:true,vision:false}} as ModelConfig;
  let funded=false;
  globalThis.fetch=(async(_url,opts)=>!opts?.method?new Response(table):!funded?new Response('private provider diagnostic',{status:402}):new Response('data: '+JSON.stringify({choices:[{delta:{tool_calls:[{index:0,id:'probe',function:{name:'capability_probe',arguments:'{"value":"verified"}'}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')) as typeof fetch;
  try {
    await refreshDeepSeekRates(config);
    assert.equal(config.routingVerification?.status,'failed');
    assert.match(config.routingVerification!.reason,/insufficient balance/);
    assert.doesNotMatch(config.routingVerification!.reason,/private provider diagnostic|fixture-funding/);
    funded=true;await refreshDeepSeekRates(config);
    assert.equal(config.routingVerification?.status,'verified');
  }finally{globalThis.fetch=original;}
});
