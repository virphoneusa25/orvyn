import type { ModelConfig } from "@orvyn/ai-core";

/** Exact non-secret account prices for endpoints without a public price API.
 * Explicit expiry prevents old account quotes becoming permanent defaults. */
export function applyConfiguredRate(config: ModelConfig, json = process.env.ORVYN_PROVIDER_RATES_JSON, now = Date.now()): void {
  if (!json) return;
  try {
    const cards = JSON.parse(json);
    if (!Array.isArray(cards)) return;
    const card = cards.find((r) => r.modelId === config.id && r.provider === (config.providerName ?? config.provider));
    if (!card || typeof card.source !== "string" || !/^https:\/\//.test(card.source) || !Number.isFinite(card.verifiedAt) || !Number.isFinite(card.expiresAt) || card.verifiedAt > now || card.expiresAt <= now || card.expiresAt - card.verifiedAt > 31 * 86_400_000) return;
    if (config.capabilities.image && Number.isFinite(card.usdPerImage) && card.usdPerImage > 0) config.imageRate = { usdPerImage: card.usdPerImage, premium: card.premium === true, source: card.source, verifiedAt: card.verifiedAt, expiresAt: card.expiresAt };
    if ([card.input, card.output, card.cachedInput ?? card.input].every((n) => Number.isFinite(n) && n >= 0)) config.rate = { input: card.input, output: card.output, cachedInput: card.cachedInput ?? card.input, source: card.source, verifiedAt: card.verifiedAt, expiresAt: card.expiresAt };
  } catch { /* Invalid configuration never becomes a guessed price. */ }
}

export function cheaperInferenceRate(item: any, source: string, now = Date.now()): ModelConfig["rate"] {
  const pricing = item?.pricing;
  if (pricing?.currency !== "USD") return undefined;
  const input = Number(pricing.input_per_million), output = Number(pricing.output_per_million), cachedInput = Number(pricing.cache_read_input_per_million);
  if ([pricing.input_per_million, pricing.output_per_million, pricing.cache_read_input_per_million].some((v) => v === null || v === undefined || v === "") || ![input, output, cachedInput].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
  return { input, output, cachedInput, source, verifiedAt: now, expiresAt: now + 10 * 60_000 };
}
