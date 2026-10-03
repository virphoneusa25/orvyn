import type { AIModelProvider } from "@orvyn/ai-core";
const pagesCache = new Map<string, { until: number; body: Promise<string>; at: number }>();
export async function refreshFireworksImageRates(providers: AIModelProvider[]): Promise<void> {
  const url = "https://fireworks.ai/models?modelTypes=Image%2CAudio%2CEmbedding%2CVision%2CServerless&provider=fireworks-ai";
  try {
    const page = publicPage(url);
    const html = (await page.body).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    for (const p of providers) {
      const kind = /flux-kontext-(pro|max)$/.exec(p.config.id)?.[1];
      if (!kind || !p.config.id.startsWith("fw:")) continue;
      const price = html.match(new RegExp(`FLUX\\.1\\s+Kontext\\s+${kind}\\s*\\$(\\d+(?:\\.\\d+)?)\\s*\\/\\s*Image`, "i"));
      if (!price || Number(price[1]) <= 0) continue;
      p.config.imageRate = { usdPerImage: Number(price[1]), premium: kind === "max", source: url, verifiedAt: page.at, expiresAt: page.at + 60 * 60_000 };
    }
  } catch { /* Cloud image preflight rejects missing/expired prices. */ }
}
function publicPage(url: string) {
  let cached = pagesCache.get(url);
  if (!cached || cached.until <= Date.now()) {
    const at = Date.now();
    cached = { at, until: at + 10 * 60_000, body: fetch(url, { signal: AbortSignal.timeout(15_000) }).then(async (r) => {
      if (!r.ok) throw new Error("Public rate source unavailable");
      return r.text();
    }) };
    pagesCache.set(url, cached);
  }
  return cached;
}

/** Public provider prices, refreshable independently of customer plans/credits. */
export async function refreshNebiusRates(providers: AIModelProvider[]): Promise<void> {
  const pages = [
    { url: "https://nebius.com/services/token-factory/models/glm-models-inference", models: ["zai-org/GLM-5.3", "zai-org/GLM-5.3-Flash"] },
    { url: "https://nebius.com/services/token-factory/models/kimi-models-inference", models: ["moonshotai/Kimi-K2.7-Code", "moonshotai/Kimi-K3"] },
  ];
  await Promise.all(pages.map(async ({ url, models }) => {
    try {
      const page = publicPage(url);
      const html = await page.body;
      for (const id of models) {
        const title = id.split("/").pop()!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const block = html.match(new RegExp(`<h2[^>]*>\\s*<span[^>]*>${title}</span></h2>([\\s\\S]*?)(?=<h2|$)`));
        const price = block?.[1].match(/\$(\d+(?:\.\d+)?)\s*\/\s*1M input tokens[^$]*\$(\d+(?:\.\d+)?)\s*\/\s*1M output tokens/);
        const config = providers.find((p) => p.config.id === `nebius:${id}`)?.config;
        if (!price || !config) continue;
        const now = page.at;
        config.rate = { input: Number(price[1]), output: Number(price[2]), source: url, verifiedAt: now, expiresAt: now + 60 * 60_000 };
      }
    } catch { /* Missing/changed public evidence never becomes a guessed price. */ }
  }));
}

/** Fireworks' public serverless model pages publish input/cache/output prices. */
export async function refreshFireworksRates(providers: AIModelProvider[]): Promise<void> {
  await Promise.all(providers.filter((p) => p.config.id.startsWith("fw:accounts/fireworks/models/") && p.config.capabilities.chat && p.config.routingVerification?.status !== "failed").map(async (p) => {
    const slug = p.config.id.split("/").pop()!;
    const url = `https://fireworks.ai/models/fireworks/${encodeURIComponent(slug)}`;
    try {
      const page = publicPage(url);
      const html = (await page.body).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
      const prices = html.match(/\$(\d+(?:\.\d+)?)\s*\/\s*(?:\$(\d+(?:\.\d+)?)\s*\/\s*)?\$(\d+(?:\.\d+)?)\s*Per\s*1M\s*Tokens/i);
      if (!prices) return;
      p.config.rate = { input: Number(prices[1]), ...(prices[2] ? { cachedInput: Number(prices[2]) } : {}), output: Number(prices[3]), source: url, verifiedAt: page.at, expiresAt: page.at + 60 * 60_000 };
    } catch { /* Changed or unavailable evidence leaves this route unpriced. */ }
  }));
}
