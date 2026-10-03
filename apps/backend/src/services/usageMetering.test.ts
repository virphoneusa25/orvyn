import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageService, type UsageEvent } from "./UsageService";

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
