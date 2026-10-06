import type { CreditLedger } from "./CreditLedger";
import type { AsyncCreditLedger } from "./AsyncFinancialStores";
import type { UsageEvent } from "../services/UsageService";
import { laneForUsage } from "./plans";

/** The request-start quote is authoritative even when a response crosses a price change. */
export async function recordProviderQuote(ledger: CreditLedger | AsyncCreditLedger, event: Pick<UsageEvent, "provider" | "modelId" | "rate" | "imageRate">): Promise<void> {
  if (event.imageRate) await ledger.setImageRateCard(event.provider, event.modelId, event.imageRate);
  if (event.rate) {
    const r = event.rate, cached = r.cachedInput ?? r.input;
    const previous = await ledger.rateCardAt(event.provider, event.modelId, r.verifiedAt);
    if (!previous || previous.provider !== event.provider || previous.modelId !== event.modelId || previous.inputUsdPerMillion !== r.input || previous.outputUsdPerMillion !== r.output || previous.cachedInputUsdPerMillion !== cached) {
      await ledger.setRateCard({ provider: event.provider, modelId: event.modelId, inputUsdPerMillion: r.input, cachedInputUsdPerMillion: cached, outputUsdPerMillion: r.output, effectiveFrom: r.verifiedAt });
    }
  }
}
export async function settleProviderUsage(ledger: CreditLedger | AsyncCreditLedger, userId: string, event: UsageEvent, own: boolean, strict: boolean): Promise<void> {
  if (!own) await recordProviderQuote(ledger, event);
  await ledger.charge({ eventId: event.id, userId, runId: event.missionId, sessionId: event.missionId,
    type: event.method === "image" ? "image" : "model", provider: event.provider, model: event.modelId, lane: laneForUsage(event),
    rateAt: event.imageRate?.verifiedAt ?? event.rate?.verifiedAt, requireExactRate: strict && !own,
    ...(own ? { providerCostUsd: 0 } : event.providerCostUsd !== undefined ? { providerCostUsd: event.providerCostUsd } : {}),
    imageCount: event.imageCount, inputTokens: event.promptTokens, cachedInputTokens: event.cachedTokens, outputTokens: event.completionTokens, ok: event.ok, now: event.timestamp });
}
