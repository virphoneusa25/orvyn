import { test } from "node:test";
import assert from "node:assert/strict";
import { applyConfiguredRate, cheaperInferenceRate } from "./configuredRates";
import { refreshOpenAIRates, refreshNebiusRates } from "./providerRates";
import type { ModelConfig } from "@orvyn/ai-core";

test("account-specific cards require exact provider/model, source and bounded freshness", () => {
  const now = Date.now(), config = { id: 'model', providerName: 'mistral', capabilities: {} } as ModelConfig;
  const card = { provider: 'mistral', modelId: 'model', input: .1, output: .3, cachedInput: .01, source: 'https://fixture.invalid/account-prices', verifiedAt: now - 100, expiresAt: now + 1000 };
  applyConfiguredRate(config, JSON.stringify([card]), now);
  assert.equal(config.rate?.input, .1);
  for (const change of [{ provider: 'other' }, { expiresAt: now - 1 }, { input: -1 }, { output: null }, { source: '' }]) {
    const rejected = { ...config, rate: undefined };
    applyConfiguredRate(rejected, JSON.stringify([{ ...card, ...change }]), now);
    assert.equal(rejected.rate, undefined);
  }
  assert.equal(cheaperInferenceRate({ pricing: { currency: 'USD', input_per_million: '.082500', cache_read_input_per_million: '.0165', output_per_million: '.275000' } }, 'https://fixture.invalid')?.cachedInput, .0165);
  assert.equal(cheaperInferenceRate({ pricing: { currency: 'USD', input_per_million: null, output_per_million: 0 } }, 'https://fixture.invalid'), undefined);
});
test("OpenAI published prices apply to the real endpoint only; Nebius handles repeated introductory headings", async () => {
  const original = globalThis.fetch;
  const openai = { config: { id: 'gpt-4o-mini', endpoint: 'https://api.openai.com', capabilities: {} } } as any;
  const custom = { config: { ...openai.config, endpoint: 'https://custom.invalid' } } as any;
  const nebius = { config: { id: 'nebius:Qwen/Qwen3.5-397B-A17B' } } as any;
  globalThis.fetch = (async (url) => new Response(String(url).includes('openai.com') ? '<div>Pricing is based on tokens. Text tokens Per 1M tokens Input $0.15 Cached input $0.075 Output $0.60</div>' : '<h2><span>Qwen3.5-397B-A17B</span></h2>Introduction<h2><span>Other</span></h2>Other<h2><span>Qwen3.5-397B-A17B</span></h2>$0.60 / 1M input tokens &middot; $3.60 / 1M output tokens')) as typeof fetch;
  try { await refreshOpenAIRates([openai, custom]); await refreshNebiusRates([nebius]); } finally { globalThis.fetch = original; }
  assert.equal(openai.config.rate.cachedInput, .075);
  assert.equal(custom.config.rate, undefined);
  assert.equal(nebius.config.rate.input, .6);
});
