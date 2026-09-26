/** 1 ORVYN base credit = $0.001 of metered provider cost, before markup. */
export const CREDIT_USD = 0.001;

export function baseCreditsForCost(providerCostUsd: number): number {
  if (!(providerCostUsd > 0)) return 0;
  return Math.ceil(providerCostUsd / CREDIT_USD - 1e-9);
}

export function customerCreditsFor(providerCostUsd: number, laneFactor: number): { baseCredits: number; customerCredits: number } {
  const baseCredits = baseCreditsForCost(providerCostUsd);
  const factor = laneFactor > 0 ? laneFactor : 1;
  return { baseCredits, customerCredits: Math.ceil(baseCredits * factor - 1e-9) };
}

export function providerCostUsd(input: {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
}): number {
  const inputTokens = Math.max(0, input.inputTokens ?? 0);
  const cached = Math.max(0, Math.min(input.cachedInputTokens ?? 0, inputTokens));
  const fresh = inputTokens - cached;
  const output = Math.max(0, input.outputTokens ?? 0);
  const usd =
    (fresh / 1_000_000) * input.inputUsdPerMillion +
    (cached / 1_000_000) * input.cachedInputUsdPerMillion +
    (output / 1_000_000) * input.outputUsdPerMillion;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
