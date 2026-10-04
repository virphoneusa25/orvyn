import type { CreditLedger } from "./CreditLedger";
import type { UsageEvent } from "../services/UsageService";
import { laneForUsage } from "./plans";

/** The request-start quote is authoritative even when a response crosses a price change. */
export function recordProviderQuote(ledger: CreditLedger, event: Pick<UsageEvent, "provider" | "modelId" | "rate" | "imageRate">): void {
  if (event.imageRate) ledger.setImageRateCard(event.provider, event.modelId, event.imageRate);
  if (event.rate) {
    const r = event.rate, cached = r.cachedInput ?? r.input;
    const previous = ledger.rateCardAt(event.provider, event.modelId, r.verifiedAt);
    if (!previous || previous.provider !== event.provider || previous.modelId !== event.modelId || previous.inputUsdPerMillion !== r.input || previous.outputUsdPerMillion !== r.output || previous.cachedInputUsdPerMillion !== cached) {
      ledger.setRateCard({ provider: event.provider, modelId: event.modelId, inputUsdPerMillion: r.input, cachedInputUsdPerMillion: cached, outputUsdPerMillion: r.output, effectiveFrom: r.verifiedAt });
    }
  }
}
export function settleProviderUsage(ledger: CreditLedger, userId: string, event: UsageEvent, own: boolean, strict: boolean): void {
  if (!own) recordProviderQuote(ledger, event);
  ledger.charge({ eventId: event.id, userId, runId: event.missionId, sessionId: event.missionId,
    type: event.method === "image" ? "image" : "model", provider: event.provider, model: event.modelId, lane: laneForUsage(event),
    rateAt: event.imageRate?.verifiedAt ?? event.rate?.verifiedAt, requireExactRate: strict && !own,
    ...(own ? { providerCostUsd: 0 } : event.providerCostUsd !== undefined ? { providerCostUsd: event.providerCostUsd } : {}),
    imageCount: event.imageCount, inputTokens: event.promptTokens, cachedInputTokens: event.cachedTokens, outputTokens: event.completionTokens, ok: event.ok, now: event.timestamp });
}
