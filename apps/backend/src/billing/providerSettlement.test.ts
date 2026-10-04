import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreditLedger } from "./CreditLedger";
import { settleProviderUsage } from "./providerSettlement";
import { LocalStore } from "../persistence/LocalStore";
import type { UsageEvent } from "../services/UsageService";
import { providerCostUsd, customerCreditsFor } from "./creditMath";

const providers = ['huggingface', 'fireworks', 'nebius', 'deepseek', 'cheaperinference', 'openai-compatible', 'mistral', 'openrouter', 'gemini'];
test("positive embedding/cache costs stay positive until credit rounding", () => {
  const cost = providerCostUsd({ inputTokens: 1, outputTokens: 0, inputUsdPerMillion: .02, cachedInputUsdPerMillion: .02, outputUsdPerMillion: 0 });
  assert.ok(cost > 0); assert.equal(customerCreditsFor(cost, 1.75).customerCredits, 2);
});
test("every platform provider settles exact model/cache prices and replays idempotently", () => {
  const dir = mkdtempSync(join(tmpdir(), 'orvyn-all-billing-')), ledger = new CreditLedger(join(dir, 'billing.sqlite'));
  const now = Date.now();
  try {
    for (const provider of providers) {
      ledger.setPlan(provider, 'starter', now);
      ledger.purchase(provider, 'pack_10k', 'checkout', now);
      const event: UsageEvent = { id: `test-${provider}`, timestamp: now, modelId: `${provider}-model`, provider, method: 'generate', durationMs: 1, ok: true, promptTokens: 1_000_000, cachedTokens: 250_000, completionTokens: 100_000,
        rate: { input: 1, cachedInput: .1, output: 2, verifiedAt: now - 100, expiresAt: now + 1000, source: 'https://fixture.invalid/pricing' } };
      settleProviderUsage(ledger, provider, event, false, true);
      const row = ledger.usageEvent(event.id) as any;
      assert.equal(row.provider_cost_micros, 975_000);
      assert.equal(row.credits_charged, 2194);
      settleProviderUsage(ledger, provider, event, false, true);
      assert.equal((ledger.usageEvent(event.id) as any).credits_charged, 2194);
    }
  } finally { ledger.close(); }
});
test("unknown exact prices cannot charge generic cards; settled gateway costs override catalog estimates", () => {
  const dir = mkdtempSync(join(tmpdir(), 'orvyn-exact-billing-')), ledger = new CreditLedger(join(dir, 'billing.sqlite'));
  try {
    assert.throws(() => ledger.charge({ userId: 'u', type: 'model', provider: 'deepseek', model: 'unknown', requireExactRate: true, inputTokens: 1000 }), /Exact provider\/model/);
    const charged = ledger.charge({ userId: 'u', type: 'model', provider: 'cheaperinference', model: 'priced', requireExactRate: true, providerCostUsd: .012345 });
    assert.equal(charged.providerCostUsd, .012345);
    assert.equal(charged.creditsCharged, 30);
    assert.throws(() => ledger.charge({ userId: 'u', type: 'model', providerCostUsd: NaN }), /Invalid provider/);
  } finally { ledger.close(); }
});
test("a pending quoted settlement survives restart and remains recoverable after a newer price", () => {
  const dir = mkdtempSync(join(tmpdir(), 'orvyn-billing-replay-')), ledger = new CreditLedger(join(dir, 'billing.sqlite'));
  let store = new LocalStore('u', dir);
  const now = Date.now();
  const event: UsageEvent = { id: 'pending', timestamp: now + 50, modelId: 'deepseek-flash', provider: 'deepseek', method: 'stream', durationMs: 50, ok: true, promptTokens: 1_000_000, completionTokens: 0, rate: { input: .15, cachedInput: .003, output: .6, verifiedAt: now, expiresAt: now + 1, source: 'https://fixture.invalid/pricing' } };
  store.enqueueBilling(event, false); store.close();
  store = new LocalStore('u', dir);
  try {
    ledger.setRateCard({ provider: 'deepseek', modelId: 'deepseek-flash', inputUsdPerMillion: .3, cachedInputUsdPerMillion: .006, outputUsdPerMillion: 1.2, effectiveFrom: now + 10 });
    const pending = store.pendingBilling(); assert.equal(pending.length, 1);
    settleProviderUsage(ledger, 'u', pending[0].event, pending[0].own, true);
    assert.equal((ledger.usageEvent(event.id) as any).provider_cost_micros, 150_000);
    store.completeBilling(event.id); assert.equal(store.pendingBilling().length, 0);
    assert.equal(ledger.rateCardAt('deepseek', 'deepseek-flash', now + 20)?.inputUsdPerMillion, .3);
  } finally { store.close(); ledger.close(); }
});
