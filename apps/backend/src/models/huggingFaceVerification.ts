import { savedVerification, type VerificationEvidence, type ProviderVerificationStore } from "./ProviderVerificationStore";
import type { ProbeOptions } from "./MeteredProviderProbe";
import type { meteredProviderProbe } from "./MeteredProviderProbe";
import { OpenAICompatibleAdapter, type ModelConfig } from "@orvyn/ai-core";
import { createHash } from "node:crypto";

type Evidence = { context: number; tools: boolean; vision: boolean; streaming: boolean; visionFailed: boolean; rate: NonNullable<ModelConfig["rate"]> };
type MeteredProbe = ReturnType<typeof meteredProviderProbe>;
type VerificationOptions = Omit<ProbeOptions, "allowPaidProbe"> & {
  meteredProbe?: MeteredProbe;
  verificationStore?: Pick<ProviderVerificationStore, "save">;
};

// Tenant services share one verified result per endpoint/model/credential in
// process memory. Credential values only participate in the hash key.
const checks = new Map<string, Promise<Evidence>>();

function configuredProvider(config: ModelConfig): { model: string; provider: string } {
  const wire = config.apiModelId ?? config.id.replace(/^hf:/, "");
  const split = wire.lastIndexOf(":");
  if (split < 0) throw new Error("an explicit inference provider is required");
  return { model: wire.slice(0, split), provider: wire.slice(split + 1) };
}

function statusFor(error: unknown): NonNullable<ModelConfig["routingVerification"]>["status"] {
  const message = String((error as Error)?.message ?? error);
  if (/catalog HTTP (401|403)/.test(message)) return "credentials_unavailable";
  if (/catalog HTTP 402|HTTP 402|insufficient balance|payment required/i.test(message)) return "account_unavailable";
  if (/catalog HTTP (404|410)|provider\/context absent|does not advertise tool calling|explicit inference provider is required/.test(message)) return "unsupported";
  if (/exact provider pricing unavailable/.test(message)) return "unverified";
  if (/stream\/tool probe did not verify advertised capabilities/.test(message)) return "unsupported";
  if (/catalog HTTP (429|5\d\d)|AbortError|TimeoutError|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network/i.test(message)) return "provider_outage";
  return "failed";
}

function safeReason(error: unknown): string {
  const message = String((error as Error)?.message ?? "");
  if (/^catalog HTTP \d+$/.test(message)) return message;
  if (/^an explicit inference provider is required$/.test(message)) return message;
  if (/^provider\/context absent from live catalog$/.test(message)) return "Configured model/provider is not live in the Hugging Face catalog";
  if (/^configured provider does not advertise tool calling$/.test(message)) return "Configured provider does not advertise tool calling";
  if (/^exact provider pricing unavailable$/.test(message)) return message;
  if (/^stream\/tool probe did not verify advertised capabilities$/.test(message)) return message;
  if (/^stream probe failed$/.test(message)) return message;
  const status = statusFor(error);
  if (status === "credentials_unavailable") return "Hugging Face credentials were rejected";
  if (status === "account_unavailable") return "Hugging Face provider account has insufficient balance or billing access";
  if (status === "provider_outage") return "Hugging Face provider or catalog is temporarily unavailable";
  return "Capability verification failed; provider diagnostics withheld";
}

async function catalog(config: ModelConfig, timeoutMs = 45_000): Promise<{ model: any; provider: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${config.endpoint}/v1/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
    const listing = await response.json() as any;
    const target = configuredProvider(config);
    const model = listing.data?.find((entry: any) => entry.id === target.model);
    const provider = model?.providers?.find((entry: any) => entry.provider === target.provider && entry.status === "live");
    if (!model || !provider || !Number.isSafeInteger(provider.context_length) || provider.context_length <= 0) {
      throw new Error("provider/context absent from live catalog");
    }
    return { model, provider };
  } finally {
    clearTimeout(timer);
  }
}

/** Free metadata lookup. It establishes route availability only; it never
 * upgrades tool, streaming, or vision capability to verified. */
export async function inspectHuggingFace(config: ModelConfig): Promise<{
  status: "available" | "credentials_unavailable" | "account_unavailable" | "unsupported" | "provider_outage" | "failed";
  reason: string;
}> {
  try {
    await catalog(config, 15_000);
    return {
      status: "available",
      reason: "Configured model and inference provider are live in the Hugging Face catalog; paid capabilities remain unverified",
    };
  } catch (error) {
    const status=statusFor(error);
    return {
      status: status==="credentials_unavailable"||status==="account_unavailable"||status==="unsupported"||status==="provider_outage" ? status : "failed",
      reason: safeReason(error),
    };
  }
}

async function check(config: ModelConfig, options: VerificationOptions, saved?: VerificationEvidence): Promise<Evidence> {
  const { model, provider } = await catalog(config);
  if (provider.supports_tools !== true) throw new Error("configured provider does not advertise tool calling");
  const tools = !saved || saved.capabilities.tools;
  let vision = model.architecture?.input_modalities?.includes("image") === true && (!saved || saved.capabilities.vision);
  let visionFailed = false;
  if (!Number.isFinite(provider.pricing?.input) || !Number.isFinite(provider.pricing?.output) || provider.pricing.input < 0 || provider.pricing.output < 0) {
    throw new Error("exact provider pricing unavailable");
  }
  const rate = {
    input: provider.pricing.input,
    output: provider.pricing.output,
    source: `${config.endpoint}/v1/models`,
    verifiedAt: Date.now(),
    expiresAt: Date.now() + 15 * 60_000,
  };
  if (saved) {
    return {
      context: Math.min(provider.context_length, saved.context),
      tools,
      vision,
      visionFailed: false,
      streaming: saved.streaming,
      rate,
    };
  }

  const probeConfig = { ...config, rate, streaming: true, capabilities: { ...config.capabilities, tools, vision } };
  const adapter = options.meteredProbe?.adapter(probeConfig) ?? options.adapter?.(probeConfig) ?? new OpenAICompatibleAdapter(probeConfig);
  let called = false, finished = false;
  for await (const chunk of adapter.stream({
    messages: [{ role: "user", content: 'Call capability_probe with value "verified". Do not answer in text.' }],
    tools: [{ name: "capability_probe", description: "Verify tool calling", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
    maxOutputTokens: 128,
    stream: true,
    signal: AbortSignal.timeout(20_000),
  })) {
    if (chunk.error) throw new Error("stream probe failed");
    called ||= chunk.toolCall?.name === "capability_probe" && chunk.toolCall.arguments.value === "verified";
    finished ||= chunk.done;
  }
  if (!finished || !called) throw new Error("stream/tool probe did not verify advertised capabilities");

  // The explicit metered procedure disallows image payloads. Preserve no vision
  // claim from catalog metadata alone; agent/tool use can still be verified.
  if (vision && !options.meteredProbe) {
    try {
      let imageText = "", imageFinished = false;
      for await (const chunk of adapter.stream({
        messages: [{ role: "user", content: "Describe the image briefly.", images: [{ url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=" }] }],
        maxOutputTokens: 128,
        stream: true,
        signal: AbortSignal.timeout(20_000),
      })) {
        if (chunk.error) throw new Error("vision probe failed");
        imageText += chunk.delta;
        imageFinished ||= chunk.done;
      }
      if (!imageFinished || !imageText.trim()) throw new Error("vision probe failed");
    } catch {
      vision = false;
      visionFailed = true;
    }
  } else if (vision && options.meteredProbe) {
    vision = false;
    visionFailed = true;
  }

  return {
    context: provider.context_length,
    tools,
    vision,
    visionFailed,
    streaming: true,
    rate,
  };
}

export async function verifyHuggingFace(config: ModelConfig, options: VerificationOptions = {}): Promise<void> {
  const saved = options.meteredProbe ? undefined : await savedVerification(config);
  if (!options.meteredProbe && !saved) {
    config.routingVerification = {
      status: "unverified",
      reason: "No current metered capability evidence; automatic paid probes are disabled. Use the explicitly authorized provider verification procedure.",
    };
    return;
  }
  const key = createHash("sha256").update(JSON.stringify([config.endpoint, config.apiModelId, config.apiKey])).digest("hex");
  const cached = options.meteredProbe ? undefined : checks.get(key);
  const pending = cached ?? check(config, options, saved);
  if (!cached && !options.meteredProbe) {
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
    config.capabilities = {
      ...config.capabilities,
      chat: true,
      code: true,
      completion: true,
      agent: evidence.tools,
      tools: evidence.tools,
      vision: evidence.vision,
    };
    if (options.meteredProbe) {
      const attempt = options.meteredProbe.successfulAttempt;
      if (!attempt || !options.verificationStore) throw new Error("metered verification evidence could not be durably recorded");
      await options.verificationStore.save(config, attempt);
    }
    config.routingVerification = {
      status: "verified",
      reason: options.meteredProbe
        ? "Live catalog and explicitly authorized budgeted streaming/tool verification recorded; vision excluded"
        : "Live catalog and saved metered capability verification",
    };
  } catch (error) {
    if (checks.get(key) === pending) checks.delete(key);
    config.routingVerification = { status: statusFor(error), reason: safeReason(error) };
  }
}
