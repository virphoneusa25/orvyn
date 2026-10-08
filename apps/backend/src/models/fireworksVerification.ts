import { createHash } from "node:crypto";
import { OpenAICompatibleAdapter, type ModelConfig } from "@orvyn/ai-core";

export const FIREWORKS_WRITING_MODEL = "accounts/fireworks/models/deepseek-v4-flash-0731";
const checks = new Map<string, Promise<{ context: number; rate: NonNullable<ModelConfig["rate"]> }>>();

/** This exact new route stays unavailable until current pricing, context and real tools verify. */
export async function verifyFireworksWriting(config: ModelConfig, options: { allowPaidProbe?: boolean } = {}): Promise<void> {
  if (options.allowPaidProbe !== true) {
    config.routingVerification = { status: "failed", reason: "Automatic paid capability probes are disabled; metered verification is required" };
    return;
  }
  const key = createHash("sha256").update(JSON.stringify([config.endpoint, config.apiKey, config.apiModelId])).digest("hex");
  let pending = checks.get(key);
  if (!pending) {
    pending = (async () => {
      const signal = AbortSignal.timeout(45_000);
      const url = "https://fireworks.ai/models/deepseek-ai/deepseek-v4-flash-0731";
      const page = await fetch(url, { signal });
      if (!page.ok) throw new Error(`Fireworks model page HTTP ${page.status}`);
      const html = (await page.text()).replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
      if (/Serverless\s+Not supported/i.test(html)) throw new Error("Fireworks model is not serverless");
      const prices = html.match(/\$(\d+(?:\.\d+)?)\s*\/\s*(?:\$(\d+(?:\.\d+)?)\s*\/\s*)?\$(\d+(?:\.\d+)?)\s*Per\s*1M\s*Tokens/i);
      const context = html.match(/([\d,]+)\s*(?:Token\s*)?Context/i) ?? html.match(/Context Length\s+([\d,]+)\s*tokens/i);
      const size = Number(context?.[1].replace(/,/g, ""));
      if (!prices || !Number.isSafeInteger(size) || size < 2048) throw new Error("Fireworks exact price/context unavailable");
      const adapter = new OpenAICompatibleAdapter({ ...config, streaming: true, capabilities: { ...config.capabilities, tools: true } });
      let called = false, finished = false;
      for await (const chunk of adapter.stream({ messages: [{ role: "user", content: 'Call capability_probe with value "verified".' }],
        tools: [{ name: "capability_probe", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, description: "Verify tools" }],
        stream: true, maxOutputTokens: 2048, signal })) {
        if (chunk.error) throw new Error("Fireworks stream/tool probe failed");
        called ||= chunk.toolCall?.name === "capability_probe" && chunk.toolCall.arguments.value === "verified";
        finished ||= chunk.done;
      }
      if (!called || !finished) throw new Error("Fireworks stream/tool probe failed");
      const now = Date.now();
      return { context: size, rate: { input: Number(prices[1]), output: Number(prices[3]), ...(prices[2] ? { cachedInput: Number(prices[2]) } : {}), source: url, verifiedAt: now, expiresAt: now + 15 * 60_000 } };
    })();
    checks.set(key, pending);
    const timer = setTimeout(() => checks.delete(key), 10 * 60_000); timer.unref();
  }
  try {
    const evidence = await pending;
    config.contextWindow = evidence.context; config.rate = evidence.rate; config.streaming = true;
    config.capabilities = { ...config.capabilities, chat: true, code: true, completion: true, agent: true, tools: true, vision: false };
    config.routingVerification = { status: "verified", reason: "Exact Fireworks model, current price/context and streaming tool call verified" };
  } catch (error) {
    const message = error instanceof Error && /^Fireworks (model page HTTP \d+|model is not serverless|exact price\/context unavailable|stream\/tool probe failed)$/.test(error.message) ? error.message : "Fireworks capability verification unavailable";
    config.routingVerification = { status: "failed", reason: message };
  }
}
