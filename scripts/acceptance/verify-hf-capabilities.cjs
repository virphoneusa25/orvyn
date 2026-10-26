// Explicit operator-only Hugging Face capability verification.
// Example inside the staging backend container:
// node scripts/acceptance/verify-hf-capabilities.cjs --authorize-paid-probe --model hf:moonshotai/Kimi-K2.7-Code:deepinfra --max-usd 0.01
// Never invoked by startup or release CI. Allows one model and one bounded
// text tool call; logs token usage/cost only and never credentials.
const path = require('node:path');

function argument(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  if (!process.argv.includes('--authorize-paid-probe')) throw new Error('Explicit --authorize-paid-probe flag is required');
  if (!/^(1|true|yes|on)$/i.test(process.env.HUGGINGFACE_ROUTING_ENABLED || '')) throw new Error('HUGGINGFACE_ROUTING_ENABLED must be enabled for this route');
  if (!(process.env.HUGGINGFACE_API_KEY?.trim() || process.env.HF_TOKEN?.trim())) throw new Error('Hugging Face credentials are unavailable');
  const modelId = argument('--model');
  if (!modelId || !/^hf:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+:deepinfra$/.test(modelId)) throw new Error('Provide one configured model id with the :deepinfra provider');
  const configured = (process.env.HUGGINGFACE_MODELS || 'zai-org/GLM-5.3:deepinfra,zai-org/GLM-5.3-Flash:deepinfra,moonshotai/Kimi-K2.7-Code:deepinfra')
    .split(',').map((x) => 'hf:' + x.trim());
  if (!configured.includes(modelId)) throw new Error('Requested model is not in HUGGINGFACE_MODELS');
  const maxUsd = Number(argument('--max-usd'));
  if (!Number.isFinite(maxUsd) || maxUsd <= 0 || maxUsd > 0.01) throw new Error('Set --max-usd to a positive amount no greater than 0.01');
  const databaseUrl = process.env.DATABASE_URL || process.env.ORVYN_PG_URL;
  if (!databaseUrl) throw new Error('Persistent PostgreSQL verification ledger is unavailable');
  if (process.env.ORVYN_POSTGRES_PRIMARY_READS !== '1' || process.env.ORVYN_POSTGRES_PRIMARY_WRITES !== '1') {
    throw new Error('Persistent verification evidence requires PostgreSQL primary reads and writes to be enabled');
  }

  const dist = path.resolve(argument('--dist') || '/app/dist');
  const { ModelService } = require(path.join(dist, 'services/ModelService.js'));
  const { verifyHuggingFace } = require(path.join(dist, 'models/huggingFaceVerification.js'));
  const { meteredProviderProbe } = require(path.join(dist, 'models/MeteredProviderProbe.js'));
  const { ProviderVerificationStore } = require(path.join(dist, 'models/ProviderVerificationStore.js'));
  const service = new ModelService();
  await service.huggingFaceReady;
  const provider = service.registry.get(modelId);
  if (!provider || provider.config.providerName !== 'huggingface') throw new Error('Configured Hugging Face model is unavailable');
  const store = new ProviderVerificationStore(databaseUrl);
  try {
    await store.init();
    const probe = meteredProviderProbe(store, undefined, Math.floor(maxUsd * 1_000_000));
    await verifyHuggingFace(provider.config, { meteredProbe: probe, verificationStore: store });
    const result = probe.result;
    const report = {
      event: 'hf.metered-verification.result',
      modelId,
      status: provider.config.routingVerification?.status || 'failed',
      reason: provider.config.routingVerification?.reason || 'No verification result',
      ...(result ? {
        attemptId: result.attemptId,
        usage: { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens, cachedTokens: result.usage.cachedTokens },
        costUsd: result.costMicros / 1_000_000,
        reservedLimitUsd: maxUsd,
      } : {}),
    };
    console.log(JSON.stringify(report));
    if (report.status !== 'verified') process.exitCode = 1;
  } finally {
    await store.close();
  }
})().catch((error) => {
  console.error(JSON.stringify({ event: 'hf.metered-verification.failed', reason: String(error?.message || 'Verification failed').slice(0, 240) }));
  process.exitCode = 1;
});
