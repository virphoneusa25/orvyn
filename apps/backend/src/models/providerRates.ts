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
export function publicPage(url: string) {
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
    { url: "https://nebius.com/services/token-factory/models/qwen-models-inference", models: ["Qwen/Qwen3.5-397B-A17B", "Qwen/Qwen3-30B-A3B-Instruct-2507"] },
    { url: "https://nebius.com/services/token-factory/models/nvidia-nemotron-models-inference", models: ["nvidia/Nemotron-3_5-Lightning"] },
  ];
  await Promise.all(pages.map(async ({ url, models }) => {
    try {
      const page = publicPage(url);
      const html = await page.body;
      for (const id of models) {
        const title = id.split("/").pop()!.replace("Nemotron-3_5", "Nemotron-3.5").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const blocks = [...html.matchAll(new RegExp(`<h2[^>]*>\\s*<span[^>]*>${title}</span></h2>([\\s\\S]*?)(?=<h2|$)`, "g"))];
        const price = blocks.map((block) => block[1].match(/\$(\d+(?:\.\d+)?)\s*\/\s*1M input tokens[^$]*\$(\d+(?:\.\d+)?)\s*\/\s*1M output tokens/)).find(Boolean);
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

/** Only the real OpenAI endpoint can use OpenAI's published prices. */
export async function refreshOpenAIRates(providers: AIModelProvider[]): Promise<void> {
  await Promise.all(providers.filter((p) => {
    try { return new URL(p.config.endpoint ?? "").origin === "https://api.openai.com" && !/(search|computer|audio|realtime)/i.test(p.config.id); } catch { return false; }
  }).map(async (p) => {
    try {
      const id = p.config.apiModelId ?? p.config.id;
      const url = `https://developers.openai.com/api/docs/models/${encodeURIComponent(id)}`;
      const page = publicPage(url);
      const plain = (await page.body).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      const section = plain.slice(plain.lastIndexOf("Pricing is based"));
      const tokens = section.match(/Text tokens Per 1M tokens[^$]*Input\s*\$(\d+(?:\.\d+)?)\s*Cached input\s*\$(\d+(?:\.\d+)?)\s*Output\s*\$(\d+(?:\.\d+)?)/);
      const embed = p.config.capabilities.embeddings ? section.match(/Embeddings Per 1M tokens[^$]*Cost\s*\$(\d+(?:\.\d+)?)/) : undefined;
      if (!tokens && !embed) return;
      p.config.rate = { input: Number(tokens?.[1] ?? embed![1]), cachedInput: Number(tokens?.[2] ?? embed![1]), output: Number(tokens?.[3] ?? 0), source: url, verifiedAt: page.at, expiresAt: page.until };
    } catch { /* Exact manual account prices may still be provided. */ }
  }));
}

export async function refreshOpenRouterRates(providers: AIModelProvider[]): Promise<void> {
  const models = providers.filter((p) => p.config.providerName === "openrouter" && p.config.endpoint === "https://openrouter.ai/api");
  if (!models.length) return;
  try {
    const url = "https://openrouter.ai/api/v1/models", page = publicPage(url);
    const data = JSON.parse(await page.body);
    for (const p of models) {
      const item = data.data?.find((m: any) => m.id === p.config.apiModelId);
      const price = item?.pricing;
      const input = Number(price?.prompt) * 1_000_000, output = Number(price?.completion) * 1_000_000;
      if (price?.prompt == null || price?.completion == null || ![input, output].every((n) => Number.isFinite(n) && n >= 0)) continue;
      const cache = price.input_cache_read == null ? input : Number(price.input_cache_read) * 1_000_000;
      if (!Number.isFinite(cache) || cache < 0) continue;
      p.config.rate = { input, output, cachedInput: cache, source: url, verifiedAt: page.at, expiresAt: page.until };
    }
  } catch { /* Unpriced routes remain ineligible for paid requests. */ }
}
