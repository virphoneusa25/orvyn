import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageService, type UsageEvent } from "./UsageService";
import { OpenAICompatibleAdapter, settledProviderCost } from "@orvyn/ai-core";

function deferred() {
  let resolve!:()=>void;
  const promise=new Promise<void>(done=>{resolve=done;});
  return {promise,resolve};
}

test("generate awaits asynchronous admission, settlement and lease cleanup before completing",async()=>{
  const usage=new UsageService(),guard=deferred(),guardEntered=deferred(),sink=deferred(),sinkEntered=deferred(),release=deferred(),releaseEntered=deferred();
  let reached=false,finished=false;
  const provider=fakeProvider([]);
  provider.generate=async()=>{reached=true;return {content:"fixture"};};
  usage.onPreflight(async()=>{guardEntered.resolve();await guard.promise;return async()=>{releaseEntered.resolve();await release.promise;};});
  usage.onRecord(async()=>{sinkEntered.resolve();await sink.promise;});
  const result=usage.wrap(provider).generate({messages:[]}).then(()=>{finished=true;});
  await guardEntered.promise;assert.equal(reached,false);
  guard.resolve();await sinkEntered.promise;assert.equal(reached,true);assert.equal(finished,false);
  sink.resolve();await releaseEntered.promise;assert.equal(finished,false);
  release.resolve();await result;assert.equal(finished,true);
  assert.equal(usage.recent().length,1);
});

test("concurrent preflights share one asynchronous retry and block providers until it finishes",async()=>{
  const usage=new UsageService(),retry=deferred(),entered=deferred();
  let ready=false,retries=0,reached=0;
  usage.onRecord(async event=>{
    if(!ready)throw new Error("fixture settlement outage");
    if(event.modelId==="pending-fixture"){retries++;entered.resolve();await retry.promise;}
  });
  await usage.record({modelId:"pending-fixture",provider:"fixture",method:"generate",durationMs:1,ok:true});
  ready=true;
  const provider=fakeProvider([]);provider.generate=async()=>{reached++;return {content:"fixture"};};
  const wrapped=usage.wrap(provider),results=Promise.all([wrapped.generate({messages:[]}),wrapped.generate({messages:[]})]);
  await entered.promise;assert.equal(retries,1);assert.equal(reached,0);
  retry.resolve();await results;assert.equal(retries,1);assert.equal(reached,2);
});

test("async guard failure awaits all earlier cleanup and preserves the admission error",async()=>{
  const usage=new UsageService(),calls:string[]=[];let reached=false;
  usage.onPreflight(async()=>async()=>{await Promise.resolve();calls.push("first");});
  usage.onPreflight(async()=>async()=>{calls.push("second");throw new Error("fixture cleanup failure");});
  usage.onPreflight(async()=>{throw new Error("fixture admission failure");});
  const provider=fakeProvider([]);provider.generate=async()=>{reached=true;return {content:"fixture"};};
  await assert.rejects(usage.wrap(provider).generate({messages:[]}),/fixture admission failure/);
  assert.deepEqual(calls,["second","first"]);assert.equal(reached,false);assert.equal(usage.recent().length,0);
});

test("image failure awaits asynchronous reservation release",async()=>{
  const usage=new UsageService(),release=deferred(),entered=deferred();let finished=false;
  usage.onPreflight(async()=>async()=>{entered.resolve();await release.promise;});
  const result=assert.rejects(usage.imageCall({id:"fixture-image",provider:"openai-compatible"},1,async()=>{throw new Error("fixture image failed");},()=>1),/fixture image failed/).then(()=>{finished=true;});
  await entered.promise;assert.equal(finished,false);
  release.resolve();await result;assert.equal(usage.recent()[0].ok,false);
});

test("early stream cancellation awaits asynchronous metering and cleanup exactly once",async()=>{
  const usage=new UsageService(),sink=deferred(),entered=deferred();let records=0,releases=0,finished=false;
  usage.onPreflight(async()=>async()=>{await Promise.resolve();releases++;});
  usage.onRecord(async()=>{records++;entered.resolve();await sink.promise;});
  const wrapped=usage.wrap(fakeProvider([{delta:"fixture",done:false},{delta:"unread",done:true}]));
  const result=(async()=>{for await(const _ of wrapped.stream({messages:[]})){break;}finished=true;})();
  await entered.promise;assert.equal(finished,false);assert.equal(releases,0);
  sink.resolve();await result;assert.equal(records,1);assert.equal(releases,1);assert.equal(usage.recent()[0].ok,true);
});

function fakeProvider(chunks: { delta: string; done: boolean; usage?: { promptTokens: number; completionTokens: number } }[]) {
  return {
    config: { id: "fake-model", provider: "openai-compatible" },
    async generate() { return { content: "hi", usage: undefined }; },
    async *stream() { for (const c of chunks) yield c; },
    healthCheck: async () => true,
    supportsTools: () => true,
    supportsVision: () => false,
  } as any;
}

test("a stream the caller stops reading early is still metered (never free)", async () => {
  const usage = new UsageService();
  const seen: UsageEvent[] = [];
  usage.onRecord((e) => seen.push(e));
  const wrapped = usage.wrap(fakeProvider([
    { delta: "Hello", done: false },
    { delta: "", done: true, usage: { promptTokens: 40, completionTokens: 8 } },
    { delta: "never read", done: false },
  ]));
  for await (const chunk of wrapped.stream({ messages: [] } as any)) {
    if (chunk.done) break;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ok, true);
  assert.equal(seen[0].promptTokens, 40);
  assert.equal(seen[0].completionTokens, 8);
});

test("a stream without reported usage is estimated, not treated as zero", async () => {
  const usage = new UsageService();
  const seen: UsageEvent[] = [];
  usage.onRecord((e) => seen.push(e));
  const wrapped = usage.wrap(fakeProvider([{ delta: "x".repeat(400), done: true }]));
  for await (const _ of wrapped.stream({ messages: [{ role: "user", content: "y".repeat(800) }] } as any)) { /* drain */ }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].estimated, true);
  assert.equal(seen[0].completionTokens, 100);
  assert.ok((seen[0].promptTokens ?? 0) >= 200);
});

test("a preflight refusal stops the call before the provider is reached", async () => {
  const usage = new UsageService();
  let reached = false;
  const p = fakeProvider([{ delta: "x", done: true }]);
  p.stream = async function* () { reached = true; yield { delta: "x", done: true }; };
  usage.onPreflight(() => { throw Object.assign(new Error("out of credits"), { billing: true }); });
  const wrapped = usage.wrap(p);
  await assert.rejects(async () => { for await (const _ of wrapped.stream({ messages: [] } as any)) { /* */ } }, /out of credits/);
  assert.equal(reached, false);
});

test("reported zero output and cached tokens are kept with the actual provider and quote", async () => {
  const usage = new UsageService();
  const provider = fakeProvider([{ delta: "", done: true, usage: { promptTokens: 20, completionTokens: 0, cachedTokens: 5 } } as any]);
  provider.config.providerName = "huggingface";
  provider.config.rate = { input: 0.9, output: 4, verifiedAt: 100, expiresAt: Date.now() + 1000, source: "fixture" };
  const wrapped = usage.wrap(provider);
  for await (const _ of wrapped.stream({ messages: [{ role: "user", content: "hello" }] } as any)) { /* drain */ }
  const event = usage.recent()[0];
  assert.equal(event.provider, "huggingface");
  assert.equal(event.completionTokens, 0);
  assert.equal(event.cachedTokens, 5);
  assert.equal(event.estimated, undefined);
  assert.equal(event.rate?.input, 0.9);
});

test("embeddings are metered once with provider-reported usage and the original quote", async () => {
  const usage = new UsageService(), p = fakeProvider([]);
  p.config.rate = { input: .02, output: 0, source: 'fixture', verifiedAt: Date.now(), expiresAt: Date.now() + 10000 };
  p.embed = async () => [1, 2]; p.embedMany = async () => [[1, 2]];
  p.embedWithUsage = async () => ({ embeddings: [[1, 2]], usage: { promptTokens: 100, completionTokens: 0 } });
  const wrapped = usage.wrap(p);
  assert.deepEqual(await wrapped.embed!('hello'), [1, 2]);
  const event = usage.recent()[0];
  assert.equal(event.method, 'embed'); assert.equal(event.promptTokens, 100); assert.equal(event.estimated, undefined); assert.equal(event.rate?.input, .02);
  await wrapped.embedMany!([]); assert.equal(usage.recent().length, 1);
});
test("gateway images charge settled cost, not the reservation ceiling or generic token card", async () => {
  const usage = new UsageService();
  const p = fakeProvider([]); p.config.providerName = 'cheaperinference'; p.config.imageSettlementBudgetUsd = .5;
  p.generateImage = async () => Object.assign([{ b64: 'fixture' }], { usage: { promptTokens: 1, completionTokens: 0, providerCostUsd: .0312 } });
  await usage.wrap(p).generateImage!({ prompt: 'fixture' });
  assert.equal(usage.recent()[0].providerCostUsd, .0312);
  p.generateImage = async () => [{ b64: 'unsettled' }];
  await assert.rejects(() => usage.wrap(p).generateImage!({ prompt: 'fixture' }), /final settled cost/);
  assert.ok(usage.recent().some((event) => event.method === 'image' && event.ok === false));
});
test("gateway cost requires a real USD settlement and survives generate and SSE adapters", async () => {
  const data = { choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 4 }, cheaper_inference: { billing: { status: 'settled', currency: 'USD', billed_cost_usd: '.012345' } } };
  // Decimal settlement strings may use a leading zero; accept only documented numeric amounts.
  data.cheaper_inference.billing.billed_cost_usd = '0.012345';
  assert.deepEqual(settledProviderCost(data, 'cheaperinference'), { providerCostUsd: .012345 });
  assert.deepEqual(settledProviderCost(data, 'other'), {});
  assert.deepEqual(settledProviderCost({ cheaper_inference: { billing: { status: 'pending', currency: 'USD', billed_cost_usd: '0.1' } } }, 'cheaperinference'), {});
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url, opts) => JSON.parse(String(opts?.body)).stream ? new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }) + '\n\ndata: ' + JSON.stringify({ ...data, choices: [] }) + '\n\ndata: [DONE]\n\n') : Response.json(data)) as typeof fetch;
  try {
    const adapter = new OpenAICompatibleAdapter({ ...fakeProvider([]).config, providerName: 'cheaperinference', endpoint: 'https://fixture.invalid', maxOutputTokens: 32 });
    assert.equal((await adapter.generate({ messages: [] })).usage?.providerCostUsd, .012345);
    const chunks = []; for await (const chunk of adapter.stream({ messages: [] })) chunks.push(chunk);
    assert.equal(chunks[chunks.length - 1]?.usage?.providerCostUsd, .012345);
  } finally { globalThis.fetch = original; }
});

test("a settlement failure is retried before another paid call can proceed", async () => {
  const usage = new UsageService(), p = fakeProvider([]);
  let ready = false, calls = 0;
  const delivered: string[] = [];
  p.generate = async () => { calls++; return { content: 'OK', usage: { promptTokens: 10, completionTokens: 1 } }; };
  usage.onRecord((event) => { if (!ready) throw new Error('fixture database unavailable'); delivered.push(event.id); });
  const wrapped = usage.wrap(p);
  await wrapped.generate({ messages: [] });
  await assert.rejects(() => wrapped.generate({ messages: [] }), /settlement is temporarily unavailable/);
  assert.equal(calls, 1);
  ready = true; await wrapped.generate({ messages: [] });
  assert.equal(calls, 2); assert.equal(new Set(delivered).size, 2);
});


test("database-backed usage waits for hydration and durable writes before returning a paid result", async () => {
  const hydrate = deferred(), writing = deferred(), entered = deferred();
  const usage = new UsageService();
  let calls = 0, finished = false;
  const stored: UsageEvent[] = [];
  usage.attachStore({
    async loadRecentUsage() { await hydrate.promise; return []; },
    async countUsageSince() { return stored.length; },
    async saveUsageEvent(event) { entered.resolve(); await writing.promise; stored.push(event); },
  });
  const provider = fakeProvider([]);
  provider.generate = async () => { calls++; return { content: "paid reply" }; };
  const result = usage.wrap(provider).generate({ messages: [] }).then(() => { finished = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
  hydrate.resolve(); await entered.promise;
  assert.equal(calls, 1); assert.equal(finished, false);
  writing.resolve(); await result;
  assert.equal(stored.length, 1);
  assert.equal((await usage.quotaAsync()).used, 1);
});

test("an asynchronous persisted quota refuses inference after restart", async () => {
  const previous = process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH;
  process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = "1";
  try {
    const usage = new UsageService();
    await usage.attachStore({ async loadRecentUsage() { return []; }, async countUsageSince() { return 2; }, async saveUsageEvent() {} });
    let reached = false;
    const provider = fakeProvider([]); provider.generate = async () => { reached = true; return { content: "unexpected" }; };
    await assert.rejects(usage.wrap(provider).generate({ messages: [] }), /quota/i);
    assert.equal(reached, false); assert.equal((await usage.quotaAsync()).used, 2);
  } finally { if (previous === undefined) delete process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH; else process.env.ORVYN_QUOTA_MODEL_REQUESTS_MONTH = previous; }
});

test("failed durable usage keeps one stable event and blocks another provider call until recovery", async () => {
  const usage = new UsageService();
  let available = false, calls = 0;
  const attempts: string[] = [], persisted: UsageEvent[] = [], settled: UsageEvent[] = [];
  await usage.attachStore({
    async loadRecentUsage() { return []; }, async countUsageSince() { return persisted.length; },
    async saveUsageEvent(event) { attempts.push(event.id); if (!available) throw new Error("outage"); persisted.push(event); },
  });
  usage.onRecord(event => { settled.push(event); });
  const provider = fakeProvider([]); provider.generate = async () => { calls++; return { content: "paid reply" }; };
  const wrapped = usage.wrap(provider);
  await assert.rejects(wrapped.generate({ messages: [] }), /Usage storage/);
  assert.equal(calls, 1); assert.equal(usage.recent().length, 1); assert.equal(usage.recent()[0].ok, true);
  await assert.rejects(wrapped.generate({ messages: [] }), /Usage storage/);
  assert.equal(calls, 1); assert.equal(settled.length, 0);
  available = true;
  await wrapped.generate({ messages: [] });
  assert.equal(calls, 2); assert.equal(persisted.length, 2); assert.equal(settled.length, 2);
  assert.equal(new Set(attempts.slice(0, 3)).size, 1);
  assert.equal(new Set(persisted.map(event => event.id)).size, 2);
});
