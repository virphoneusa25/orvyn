import {savedVerification} from "./ProviderVerificationStore";
import type {ProbeOptions} from "./MeteredProviderProbe";
import { createHash } from "node:crypto";
import { OpenAICompatibleAdapter, type ModelConfig } from "@orvyn/ai-core";
import { publicPage } from "./providerRates";

export const DEEPSEEK_PRICE_SOURCE = "https://api-docs.deepseek.com/quick_start/pricing/";
// State Council 2026 holiday notice: https://www.gov.cn/zhengce/content/202511/content_7047090.htm
const holidays2026 = [["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"], ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"]];
type Price = { input: number; cachedInput: number; output: number };
export type DeepSeekPrices = Record<"deepseek-flash" | "deepseek-v4-pro", { peak: Price; offPeak: Price }>;

/** Reject changed table layouts rather than silently applying another model's price. */
export function parseDeepSeekPrices(html: string): DeepSeekPrices {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1].replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()));
  const header = rows.find((r) => r[0] === "MODEL");
  if (header?.[1] !== "deepseek-flash" || header?.[2] !== "deepseek-v4-pro") throw new Error("DeepSeek price model columns changed");
  const priced = rows.filter((r) => r.some((c) => /^\$/.test(c)));
  if (priced.length !== 6 || !priced[0].some((c) => /CACHE HIT/.test(c)) || !priced[2].some((c) => /CACHE MISS/.test(c)) || !priced[4].some((c) => /OUTPUT TOKENS/.test(c))) throw new Error("DeepSeek price layout changed");
  const pairs = priced.map((r, i) => {
    if (!r.includes(i % 2 ? "PEAK" : "OFF-PEAK")) throw new Error("DeepSeek price schedule changed");
    const values = r.filter((c) => /^\$/.test(c)).map((c) => /^\$\d+(?:\.\d+)?$/.test(c) ? Number(c.slice(1)) : NaN);
    if (values.length !== 2 || values.some((n) => !Number.isFinite(n) || n <= 0)) throw new Error("DeepSeek price unavailable");
    return values;
  });
  return Object.fromEntries(["deepseek-flash", "deepseek-v4-pro"].map((id, i) => [id, { offPeak: { cachedInput: pairs[0][i], input: pairs[2][i], output: pairs[4][i] }, peak: { cachedInput: pairs[1][i], input: pairs[3][i], output: pairs[5][i] } }])) as DeepSeekPrices;
}

export function deepSeekPeak(at: number): boolean {
  const d = new Date(at), hour = d.getUTCHours();
  if (d.getUTCDay() === 0 || d.getUTCDay() === 6 || !((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10))) return false;
  if (d.getUTCFullYear() !== 2026) throw new Error("DeepSeek holiday calendar needs updating");
  const day = d.toISOString().slice(5, 10);
  return !holidays2026.some(([start, end]) => day >= start && day <= end);
}

const probes = new Map<string, { until: number; pending: Promise<void> }>();
export async function refreshDeepSeekRates(config: ModelConfig, options: ProbeOptions = {}): Promise<void> {
  const evidence=options.allowPaidProbe===true?undefined:await savedVerification(config);
  if (options.allowPaidProbe !== true && !evidence) {
    config.routingVerification = { status: "failed", reason: "Automatic paid capability probes are disabled; metered verification is required" };
    return;
  }
  try {
    if (new URL(config.endpoint!).origin !== "https://api.deepseek.com") throw new Error("Custom endpoint requires its own verified prices");
    const id = config.apiModelId ?? config.id;
    if (id !== "deepseek-flash" && id !== "deepseek-v4-pro") throw new Error("Exact DeepSeek model price unavailable");
    const page = publicPage(DEEPSEEK_PRICE_SOURCE);
    const html = await page.body;
    const prices = parseDeepSeekPrices(html)[id];
    // The price table alone is insufficient: check the advertised peak schedule too.
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    if (!/01:00/.test(text) || !/04:00/.test(text) || !/06:00/.test(text) || !/10:00/.test(text) || !/UTC/.test(text) || !/Monday through Friday/.test(text) || !/excluding Chinese public holidays/i.test(text)) throw new Error("DeepSeek peak schedule unavailable");
    Object.defineProperty(config, "rate", { configurable: true, enumerable: true, get() {
      const now = Date.now();
      try {
        if (now >= page.until) return undefined;
        return { ...(deepSeekPeak(now) ? prices.peak : prices.offPeak), source: DEEPSEEK_PRICE_SOURCE, verifiedAt: now, expiresAt: Math.min(page.until, Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000) };
      } catch { return undefined; }
    } });
    const key = createHash("sha256").update(JSON.stringify([config.endpoint, config.apiKey, id])).digest("hex");
    let probe = options.allowPaidProbe === true ? undefined : probes.get(key);
    if (!evidence && (!probe || probe.until <= Date.now())) {
      probe = { until: Date.now() + 60 * 60_000, pending: (async () => {
        const adapter = options.adapter?.(config) ?? new OpenAICompatibleAdapter(config);
        let called = false, done = false;
        for await (const chunk of adapter.stream({ messages: [{ role: "user", content: 'Call capability_probe with value "verified".' }], tools: [{ name: "capability_probe", description: "Verify tool calls", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }], stream: true, maxOutputTokens: 2048, signal: AbortSignal.timeout(45_000) })) {
          if (chunk.error) throw new Error("DeepSeek tool probe failed");
          called ||= chunk.toolCall?.name === "capability_probe" && chunk.toolCall.arguments.value === "verified";
          done ||= chunk.done;
        }
        if (!called || !done) throw new Error("DeepSeek tool probe failed");
      })() };
      probes.set(key, probe);
      probe.pending.catch(() => probes.delete(key));
    }
    if (!evidence) await probe!.pending;
    config.contextWindow = 1_000_000;
    config.routingVerification = { status: "verified", reason: evidence ? "Current exact prices and saved metered streaming tool verification" : "Exact current DeepSeek prices and streaming tool call verified" };
  } catch (error) {
    // Expose only a known status, never raw provider responses or credentials.
    const insufficientBalance=error instanceof Error&&/\bHTTP 402\b/.test(error.message);
    config.routingVerification = { status: "failed", reason: insufficientBalance
      ? "DeepSeek account has insufficient balance; fund the provider account to restore service"
      : "Direct DeepSeek current price, schedule or tool verification unavailable" };
  }
}
