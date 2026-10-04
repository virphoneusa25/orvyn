// Runs inside the hosted backend with its server-side credentials. All customer
// identity, wallets, usage and outbox writes are isolated in a temporary directory.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'orvyn-provider-billing-'));
process.env.ORVYN_DATA_DIR = scratch;
process.env.ORVYN_PROJECTS_DIR = path.join(scratch, 'projects');
process.env.ORVYN_CLOUD_MODE = 'true';
process.env.ORVYN_ENFORCE_CREDITS = 'true';
const root = process.argv[2] || '/app/dist';
const { TenantManager } = require(root + '/tenancy/TenantManager.js');
const { creditLedger: ledger } = require(root + '/billing/creditLedgerInstance.js');
const { providerCostUsd, customerCreditsFor } = require(root + '/billing/creditMath.js');
const { incompatibility } = require('/app/node_modules/@orvyn/ai-core');

(async () => {
  const tenant = new TenantManager().create('Provider billing verification', '', 'billing_fixture');
  const service = tenant.modelService;
  ledger.setPlan(tenant.id, 'pro', Date.now(), 'isolated-provider-verification');
  ledger.purchase(tenant.id, 'pack_10k', 'checkout');
  await service.huggingFaceReady; await service.imageReady;
  const models = service.registry.list().filter((p) => p.config.apiKey);
  const inventory = models.map((p) => ({ modelId: p.config.id, provider: p.config.providerName ?? p.config.provider, rate: p.config.rate, imageRate: p.config.imageRate,
    imageReservationUsd: p.config.imageSettlementBudgetUsd,
    unavailableReason: incompatibility(p.config, { capability: p.config.capabilities.image ? 'image' : p.config.capabilities.embeddings ? 'embeddings' : 'chat' }) }));
  for (const p of models) {
    if (!p.config.rate && !p.config.imageRate && !p.config.imageSettlementBudgetUsd) assert.ok(incompatibility(p.config, { capability: 'chat' }), 'Unpriced platform route must be ineligible');
  }
  console.log(JSON.stringify({ event: 'billing.inventory', inventory }));
  const checks = [
    ['huggingface', 'hf:moonshotai/Kimi-K2.7-Code:deepinfra', true],
    ['deepseek', process.env.DEEPSEEK_CODE_MODEL?.trim() || 'deepseek-flash', true],
    ['fireworks', 'fw:accounts/fireworks/models/glm-5p3-flash', true],
    ['nebius', 'nebius:zai-org/GLM-5.3-Flash', true],
    ['cheaperinference', 'ci:glm-5.3-flash', true],
    ['openai-compatible', process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini', false],
  ];
  const evidence = [];
  for (const [providerName, id, required] of checks) {
    const p = service.registry.get(id);
    if (!p) { assert.equal(required, false, `Required provider ${providerName} unavailable`); continue; }
    assert.equal(p.config.providerName ?? p.config.provider, providerName);
    assert.ok(p.config.rate && p.config.rate.expiresAt > Date.now(), `Exact rate missing for ${providerName}`);
    let called = false, done = false, failed = false;
    try {
      for await (const c of p.stream({ messages: [{ role: 'user', content: 'Call billing_probe with value "verified". Do not answer in text.' }], tools: [{ name: 'billing_probe', description: 'Verify tools and billing', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } }], stream: true, maxOutputTokens: 4096, signal: AbortSignal.timeout(55000) })) {
        if (c.error) throw new Error('Provider streaming failure');
        called ||= c.toolCall?.name === 'billing_probe' && c.toolCall.arguments.value === 'verified'; done ||= c.done;
      }
    } catch { failed = true; }
    const event = service.usage.recent().find((e) => e.modelId === id);
    assert.ok(event); assert.equal(event.provider, providerName);
    const charge = ledger.usageEvent(event.id); assert.ok(charge);
    if (failed) {
      assert.equal(charge.credits_charged, 0);
      assert.equal(required, false, `Required provider ${providerName} failed live billing/tool verification`);
      evidence.push({ provider: providerName, modelId: id, status: 'unavailable', failedUsageCharged: 0 }); continue;
    }
    assert.ok(called && done); assert.equal(event.ok, true); assert.equal(event.estimated, undefined);
    const quote = event.rate;
    const cost = event.providerCostUsd ?? providerCostUsd({ inputTokens: event.promptTokens, cachedInputTokens: event.cachedTokens, outputTokens: event.completionTokens, inputUsdPerMillion: quote.input, cachedInputUsdPerMillion: quote.cachedInput ?? quote.input, outputUsdPerMillion: quote.output });
    assert.equal(charge.provider_cost_micros, Math.round(cost * 1e6));
    assert.equal(charge.credits_charged, customerCreditsFor(cost, 2.25).customerCredits);
    if (providerName === 'cheaperinference') assert.ok(event.providerCostUsd !== undefined);
    evidence.push({ provider: providerName, modelId: id, status: 'passed', promptTokens: event.promptTokens, cachedTokens: event.cachedTokens, completionTokens: event.completionTokens, providerCostUsd: cost, creditsCharged: charge.credits_charged, toolCalling: called });
  }
  const image = service.registry.get('ci:nano-banana');
  assert.ok(image?.config.capabilities.image, 'Priced image route unavailable');
  const images = await image.generateImage({ prompt: 'A plain blue square on a white background.', n: 1, size: '1024x1024' });
  assert.equal(images.length, 1);
  const imageEvent = service.usage.recent().find((e) => e.method === 'image');
  const imageCharge = ledger.usageEvent(imageEvent.id);
  assert.ok(imageEvent.providerCostUsd > 0); assert.ok(imageCharge.credits_charged > 0);
  assert.equal(imageCharge.provider_cost_micros, Math.round(imageEvent.providerCostUsd * 1e6));
  assert.equal(imageCharge.credits_charged, customerCreditsFor(imageEvent.providerCostUsd, 3).customerCredits);
  evidence.push({ provider: 'cheaperinference', modelId: image.config.id, method: 'image', status: 'passed', imageCount: images.length, providerCostUsd: imageEvent.providerCostUsd, creditsCharged: imageCharge.credits_charged });
  assert.equal(tenant.localStore.pendingBilling().length, 0);
  console.log(JSON.stringify({ event: 'billing.preflight.result', passed: true, isolatedCustomerData: true, evidence }));
})().catch(() => { console.log(JSON.stringify({ event: 'billing.preflight.failed', reason: 'Exact provider pricing, live tools or settled credits did not verify; raw provider errors withheld' })); process.exitCode = 1;
}).finally(() => { ledger.close(); if (path.dirname(scratch) === os.tmpdir() && path.basename(scratch).startsWith('orvyn-provider-billing-')) fs.rmSync(scratch, { recursive: true, force: true }); process.exit(process.exitCode || 0); });
