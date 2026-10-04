import { OpenAICompatibleAdapter, type ModelConfig } from "@orvyn/ai-core";
import { createHash } from "node:crypto";

type Evidence = { context: number; tools: boolean; vision: boolean; streaming: boolean; visionFailed: boolean; rate: NonNullable<ModelConfig["rate"]> };
// Tenant services share one verification per endpoint/model/credential in memory.
// Credentials are never persisted, returned to clients, or included in diagnostics.
const checks = new Map<string, Promise<Evidence>>();

async function check(config: ModelConfig): Promise<Evidence> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(`${config.endpoint}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` }, signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const catalog = await response.json() as any;
    const wire = config.apiModelId ?? config.id.replace(/^hf:/, "");
    const split = wire.lastIndexOf(":");
    if (split < 0) throw new Error("an explicit inference provider is required");
    const model = catalog.data?.find((m: any) => m.id === wire.slice(0, split));
    const provider = model?.providers?.find((p: any) => p.provider === wire.slice(split + 1) && p.status === "live");
    if (!provider || !Number.isSafeInteger(provider.context_length) || provider.context_length <= 0) throw new Error("provider/context absent from live catalog");
    const tools = provider.supports_tools === true;
    let vision = model.architecture?.input_modalities?.includes("image") === true;
    let visionFailed = false;
    const probeConfig = { ...config, streaming: true, capabilities: { ...config.capabilities, tools, vision } };
    const adapter = new OpenAICompatibleAdapter(probeConfig);
    let text = "", called = false, finished = false;
    for await (const chunk of adapter.stream({
      messages: [{ role: "user", content: tools ? 'Call capability_probe with value "verified". Do not answer in text.' : "Reply with OK." }],
      ...(tools ? { tools: [{ name: "capability_probe", description: "Verify tool calling", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }] } : {}),
      maxOutputTokens: 2048, stream: true, signal: controller.signal,
    })) {
      if (chunk.error) throw new Error("stream probe failed");
      text += chunk.delta;
      called ||= chunk.toolCall?.name === "capability_probe" && chunk.toolCall.arguments.value === "verified";
      finished ||= chunk.done;
    }
    if (!finished || (tools ? !called : !text.trim())) throw new Error("stream/tool probe did not verify advertised capabilities");
    if (vision) {
      try {
      let imageText = "", imageFinished = false;
      for await (const chunk of adapter.stream({ messages: [{ role: "user", content: "Describe the image briefly.", images: [{ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=" }] }], maxOutputTokens: 2048, stream: true, signal: controller.signal })) {
        if (chunk.error) throw new Error("vision probe failed");
        imageText += chunk.delta; imageFinished ||= chunk.done;
      }
      if (!imageFinished || !imageText.trim()) throw new Error("vision probe failed");
      } catch { vision = false; visionFailed = true; }
    }
    if (!Number.isFinite(provider.pricing?.input) || !Number.isFinite(provider.pricing?.output) || provider.pricing.input < 0 || provider.pricing.output < 0) throw new Error("exact provider pricing unavailable");
    const now = Date.now();
    return { context: provider.context_length, tools, vision, visionFailed, streaming: true, rate: { input: provider.pricing.input, output: provider.pricing.output, source: `${config.endpoint}/v1/models`, verifiedAt: now, expiresAt: now + 15 * 60_000 } };
  } finally { clearTimeout(timer); }
}

export async function verifyHuggingFace(config: ModelConfig): Promise<void> {
  const key = createHash("sha256").update(JSON.stringify([config.endpoint, config.apiModelId, config.apiKey])).digest("hex");
  let pending = checks.get(key);
  if (!pending) {
    // A cold/transient provider failure must not poison every tenant for ten minutes.
    pending = check(config).catch(async (error) => {
      const retryable = error?.name === 'AbortError' || error?.name === 'TimeoutError' || /^(catalog HTTP (429|5\d\d)|stream probe failed|stream\/tool probe did not verify advertised capabilities)$/.test(error?.message ?? '');
      if (!retryable) throw error;
      return check(config);
    });
    checks.set(key, pending);
    const expiry = setTimeout(() => checks.delete(key), 10 * 60_000);
    expiry.unref();
  }
  try {
    const evidence = await pending;
    config.contextWindow = evidence.context;
    config.maxOutputTokens = Math.min(config.maxOutputTokens, evidence.context);
    config.streaming = evidence.streaming;
    config.rate = evidence.rate;
    config.capabilities = { ...config.capabilities, chat: true, code: true, completion: true, agent: evidence.tools, tools: evidence.tools, vision: evidence.vision };
    config.routingVerification = { status: "verified", reason: evidence.visionFailed ? "Catalog and streaming/tool probes verified; vision probe failed, images excluded" : "Live provider catalog and streaming/tool/vision probes verified" };
  } catch (error) {
    if (checks.get(key) === pending) checks.delete(key);
    // Only our bounded status codes/messages reach logs or the renderer. Raw provider errors can contain credentials.
    const message = error instanceof Error && /^(catalog HTTP \d+|an explicit inference provider is required|provider\/context absent from live catalog|stream probe failed|stream\/tool probe did not verify advertised capabilities|vision probe failed)$/.test(error.message) ? error.message : "capability verification unavailable";
    config.routingVerification = { status: "failed", reason: message };
  }
}
