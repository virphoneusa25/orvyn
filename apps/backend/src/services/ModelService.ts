// apps/backend/src/services/ModelService.ts
import "../loadEnv";
import {
  ModelRegistry,
  ModelRouter,
  ModelConfig,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  MockAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  AIModelProvider,
  TaskType,
} from "@orvyn/ai-core";
import { UsageService } from "./UsageService";
import { CERTIFIED_MODELS } from "../models/certifiedModels";
import { markModelUnavailable } from "../models/modelAvailability";
import { isRouteBlocked } from "../models/modelAvailability";
import { verifyHuggingFace } from "../models/huggingFaceVerification";
import { FIREWORKS_WRITING_MODEL, verifyFireworksWriting } from "../models/fireworksVerification";
import { refreshNebiusRates, refreshFireworksRates, refreshFireworksImageRates, refreshOpenAIRates, refreshOpenRouterRates } from "../models/providerRates";
import { refreshDeepSeekRates } from "../models/deepseekRates";
import { applyConfiguredRate, cheaperInferenceRate } from "../models/configuredRates";
import { NEBIUS_CURATED, NEBIUS_EMBED_DIMS, NEBIUS_EMBED_MODEL } from "../models/modelEquivalents";

function openaiDisplayName(id: string): string {
  if (id === "gpt-4o") return "OpenAI GPT-4o";
  if (id === "gpt-4o-mini") return "OpenAI GPT-4o mini";
  return `OpenAI ${id}`;
}

/**
 * Output budget per reply. A whole stylesheet or page in one write_file call,
 * plus a reasoning model's thinking, overflows 8k and the call arrives cut off.
 * Long-context models get 16k (ORVYN_AGENT_MAX_OUTPUT_TOKENS to change); the
 * adapter steps back to 8k if a server refuses.
 */
function agentOutputTokens(contextWindow: number): number {
  const configured = Number(process.env.ORVYN_AGENT_MAX_OUTPUT_TOKENS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return contextWindow >= 64000 ? 16384 : 8192;
}

function cheaperInferenceConfig(
  id: string,
  apiKey: string,
  temperature: number,
  endpoint: string,
  kind: "text" | "image" = "text"
): ModelConfig {
  const isImage = kind === "image";
  return {
    id: `ci:${id}`,
    apiModelId: id,
    name: `Cheaper Inference ${id}`,
    providerName: "cheaperinference",
    settledCostRequired: true,
    provider: "openai-compatible",
    endpoint,
    apiKey,
    contextWindow: isImage ? 4096 : 128000,
    maxOutputTokens: isImage ? 1 : 4096,
    defaultTemperature: temperature,
    defaultTopP: 1,
    streaming: !isImage,
    capabilities: {
      chat: !isImage,
      code: !isImage,
      agent: !isImage,
      tools: !isImage,
      vision: !isImage,
      embeddings: false,
      completion: !isImage,
      image: isImage,
    },
  };
}

function cheaperInferenceEndpoint(): string {
  return (process.env.CHEAPER_INFERENCE_BASE_URL?.trim() || "https://api.cheaperinference.com").replace(/\/v1\/?$/, "");
}

function cheaperInferenceModels(): string[] {
  const chatId = process.env.CHEAPER_INFERENCE_CHAT_MODEL?.trim() || "gpt-5.6-luna";
  const codeId = process.env.CHEAPER_INFERENCE_CODE_MODEL?.trim() || "gpt-5.6-terra";
  const extra = (process.env.CHEAPER_INFERENCE_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const certified = CERTIFIED_MODELS.filter((m) => m.provider === "cheaper-inference" && !m.image).map((m) => m.apiModelId);
  // Seed every production routing lane synchronously. The live catalog refresh
  // later stamps exact capabilities, but routing must be correct from boot.
  const routed = ["glm-5.3-flash", "glm-5.3", "kimi-k3", "deepseek-v4-flash", "deepseek-v4-pro", "gemini-3.7-flash", "google/gemini-3.5-flash-lite"];
  return [...new Set([chatId, codeId, ...routed, ...extra, ...certified])];
}

// DeepSeek speaks the OpenAI wire protocol, so the existing adapter carries it.
// The coding worker defaults to the flash tier; pro is registered alongside for
// the user to route manually in Settings.
function fireworksConfig(
  id: string,
  apiKey: string,
  temperature: number,
  lane?: { contextWindow: number; tools: boolean; vision: boolean; agent: boolean; image: boolean; imageEditing: boolean }
): ModelConfig {
  const image = lane?.image ?? false;
  return {
    id: `fw:${id}`,
    apiModelId: id,
    name: `Fireworks ${id.split("/").pop() ?? id}`,
    provider: "openai-compatible",
    providerName: "fireworks",
    endpoint: (process.env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference").replace(/\/v1\/?$/, ""),
    apiKey,
    contextWindow: lane?.contextWindow ?? 128000,
    maxOutputTokens: image ? 1 : agentOutputTokens(lane?.contextWindow ?? 128000),
    defaultTemperature: temperature,
    defaultTopP: 1,
    streaming: !image,
    capabilities: {
      chat: !image,
      code: !image,
      agent: lane?.agent ?? !image,
      tools: lane?.tools ?? !image,
      vision: lane?.vision ?? false,
      embeddings: false,
      completion: !image,
      image,
      imageEditing: lane?.imageEditing ?? false,
    },
  };
}

/** An OpenAI-compatible provider model (Mistral, OpenRouter): same streaming and tool-call path. */
function openAiCompatibleConfig(prefix: string, label: string, endpoint: string, id: string, apiKey: string, temperature: number, contextWindow: number): ModelConfig {
  return {
    providerName: prefix === "hf" ? "huggingface" : prefix,
    id: `${prefix}:${id}`, apiModelId: id, name: `${label} ${id.split("/").pop() ?? id}`, provider: "openai-compatible",
    endpoint: endpoint.replace(/\/v1\/?$/, ""),
    apiKey, contextWindow, maxOutputTokens: agentOutputTokens(contextWindow), defaultTemperature: temperature, defaultTopP: 1, streaming: true,
    capabilities: { chat: true, code: true, agent: true, tools: true, vision: false, embeddings: false, completion: true, image: false },
  };
}

/** Models ORVYN's routing policy uses from each provider (models/routingPolicy.ts). */
const MISTRAL_MODELS: { id: string; context: number; temperature: number }[] = [
  { id: "mistral-small-4-0-26-03", context: 128000, temperature: 0.3 },
  { id: "codestral-25-08", context: 256000, temperature: 0.2 },
  { id: "mistral-medium-3-5-26-04", context: 128000, temperature: 0.3 },
  { id: "mistral-large-3-25-12", context: 128000, temperature: 0.3 },
  { id: "zai-glm-5-3", context: 200000, temperature: 0.2 },
];
const OPENROUTER_MODELS: { id: string; context: number; temperature: number }[] = [
  { id: "deepseek/deepseek-v3.2", context: 163840, temperature: 0.2 },
  { id: "minimax/minimax-m2.5", context: 205000, temperature: 0.2 },
];
const FIREWORKS_VISION_MODELS = new Set([
  "accounts/fireworks/models/qwen3-vl-8b-instruct",
  "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct",
  "accounts/fireworks/models/qwen3-vl-32b-instruct",
]);

function nebiusEndpoint(): string {
  return (process.env.NEBIUS_BASE_URL?.trim() || "https://api.tokenfactory.nebius.com").replace(/\/v1\/?$/, "");
}

function huggingFaceEndpoint(): string {
  return (process.env.HUGGINGFACE_BASE_URL?.trim() || "https://router.huggingface.co/v1").replace(/\/v1\/?$/, "");
}

/** Extra Nebius models to show in the model menu (NEBIUS_MODELS), besides the curated set. */
function nebiusModelList(): string[] {
  return (process.env.NEBIUS_MODELS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

/** The embedding model ORVYN uses for memory and code search, when chosen explicitly. */
export function embedModelChoice(env: NodeJS.ProcessEnv = process.env): { id: string; dims: number } | null {
  const id = env.ORVYN_EMBED_MODEL?.trim();
  if (!id) return null;
  const dims = Number(env.ORVYN_EMBED_DIMS) || (id === `nebius:${NEBIUS_EMBED_MODEL}` ? NEBIUS_EMBED_DIMS : 1536);
  return { id, dims };
}

function geminiConfig(id: string, apiKey: string, temperature: number): ModelConfig {
  // Gemini exposes an OpenAI-compatible endpoint, allowing ORVYN to use the
  // same proven streaming/tool-call path instead of a nonfunctional placeholder.
  return {
    id: `gemini:${id}`, apiModelId: id, name: `Google ${id}`, provider: "openai-compatible",
    endpoint: (process.env.GEMINI_OPENAI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/v1\/?$/, ""),
    apiKey, contextWindow: 1000000, maxOutputTokens: 8192, defaultTemperature: temperature, defaultTopP: 1, streaming: true,
    capabilities: { chat: true, code: true, agent: true, tools: true, vision: true, embeddings: false, completion: true, image: false },
  };
}

function deepseekConfig(id: string, apiKey: string, endpoint: string, temperature: number): ModelConfig {
  return {
    id,
    name: `DeepSeek ${id.replace(/^deepseek-/, "")}`,
    provider: "openai-compatible",
    providerName: "deepseek",
    routingVerification: { status: "failed", reason: "Direct DeepSeek requires an exact, refreshable billing rate card before customer routing" },
    endpoint,
    apiKey,
    contextWindow: 128000,
    maxOutputTokens: 8192,
    defaultTemperature: temperature,
    defaultTopP: 1,
    streaming: true,
    capabilities: {
      chat: true,
      code: true,
      agent: true,
      tools: true,
      vision: false,
      embeddings: false,
      completion: true,
      image: false,
    },
  };
}

function openaiConfig(id: string, apiKey: string, temperature: number): ModelConfig {
  return {
    id,
    name: openaiDisplayName(id),
    provider: "openai-compatible",
    endpoint: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
    apiKey,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    defaultTemperature: temperature,
    defaultTopP: 1,
    streaming: true,
    capabilities: {
      chat: true,
      code: true,
      agent: true,
      tools: true,
      vision: true,
      embeddings: false,
      completion: true,
      image: false,
    },
  };
}

// NOTE: Phase 1 persists model configs in memory only.
// Phase 7 (production) should move this to Postgres via Prisma (see docs/architecture.md).
export class ModelService {
  public registry = new ModelRegistry();
  /** Models the customer added themselves (their key, their endpoint). Everything else is ORVYN's. */
  public readonly userModelIds = new Set<string>();
  /** A customer's own model that replaces ORVYN's routing when "Auto" is chosen (null: ORVYN routes). */
  public preferredModel: string | null = null;

  isUserModel(id: string): boolean {
    return this.userModelIds.has(id);
  }

  /** The model a run/chat should use when the customer chose Auto (their default, if set and registered). */
  effectiveRequest(requested: string | undefined, task?: TaskType): string | undefined {
    const r = requested?.trim();
    if ((!r || r === "auto") && this.preferredModel && this.registry.get(this.preferredModel)) return this.preferredModel;
    if ((!r || r === "auto") && task) return this.router.getExplicitOverrides()[task] ?? requested;
    return requested;
  }
  public router = new ModelRouter(this.registry);
  public huggingFaceReady: Promise<void> = Promise.resolve();
  public imageReady: Promise<void> = Promise.resolve();
  /** Server-side usage metering — every provider registered here is wrapped. */
  public usage = new UsageService();
  /** Registered, callable, but kept out of the model menu (a provider's long tail). */
  private moreModels = new Set<string>();

  constructor() {
    this.router.setAutoPolicy({ enabled: () => /^(1|true|yes|on)$/i.test(process.env.HUGGINGFACE_ROUTING_ENABLED?.trim() ?? ""), unavailable: isRouteBlocked });
    // Seed with a mock model so the IDE is runnable with zero config.
    this.addModel({
      id: "orvyn-mock",
      name: "ORVYN Mock (no model configured)",
      provider: "mock",
      endpoint: "",
      contextWindow: 8192,
      maxOutputTokens: 2048,
      defaultTemperature: 0.3,
      defaultTopP: 1,
      streaming: true,
      capabilities: {
        chat: true,
        code: true,
        agent: true,
        tools: true,
        vision: false,
        embeddings: false,
        completion: true,
        image: false,
      },
    });

    const openaiKey = process.env.MODEL_API_KEY?.trim();
    const chatId = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";
    const codeId = process.env.OPENAI_CODE_MODEL?.trim() || "gpt-4o";
    if (openaiKey) {
      this.addModel(openaiConfig(chatId, openaiKey, 0.7));
      if (codeId !== chatId) {
        this.addModel(openaiConfig(codeId, openaiKey, 0.2));
      }
      const embedId = process.env.OPENAI_EMBED_MODEL?.trim() || "text-embedding-3-small";
      this.addModel({
        id: embedId,
        name: "OpenAI Embeddings",
        provider: "openai-compatible",
        endpoint: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com",
        apiKey: openaiKey,
        contextWindow: 8192,
        maxOutputTokens: 1,
        defaultTemperature: 0,
        defaultTopP: 1,
        streaming: false,
        capabilities: {
          chat: false,
          code: false,
          agent: false,
          tools: false,
          vision: false,
          embeddings: true,
          completion: false,
          image: false,
        },
      });
    }

    const ciKey = process.env.CHEAPER_INFERENCE_API_KEY?.trim();
    if (ciKey) {
      const ciEndpoint = cheaperInferenceEndpoint();
      const ciModels = cheaperInferenceModels();
      const chatId = process.env.CHEAPER_INFERENCE_CHAT_MODEL?.trim() || ciModels[0];
      const codeId = process.env.CHEAPER_INFERENCE_CODE_MODEL?.trim() || ciModels[1] || chatId;
      for (const id of ciModels) {
        this.addModel(cheaperInferenceConfig(id, ciKey, id === codeId && id !== chatId ? 0.2 : 0.7, ciEndpoint, "text"));
      }
      this.huggingFaceReady = this.refreshCheaperInferenceCatalog();
    }

    const fireworksKey = process.env.FIREWORKS_API_KEY?.trim();
    if (fireworksKey) {
      const certified = CERTIFIED_MODELS.filter((m) => m.provider === "fireworks").map((m) => m.apiModelId);
      const extra = (process.env.FIREWORKS_MODELS ?? process.env.FIREWORKS_MODEL ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      // Qwen3-VL on Fireworks is Deploy on Demand. Register only explicit
      // account deployments, avoiding a guaranteed 404 on serverless plans.
      const deployedVision = (process.env.FIREWORKS_VISION_MODELS ?? "")
        .split(",").map((s) => s.trim()).filter((id) => FIREWORKS_VISION_MODELS.has(id));
      for (const id of [...new Set([...certified, ...extra, ...deployedVision])]) {
        const lane = CERTIFIED_MODELS.find((m) => m.apiModelId === id);
        const visionLane = deployedVision.includes(id)
          ? { contextWindow: 262144, tools: true, vision: true, agent: true, image: false, imageEditing: false }
          : undefined;
        this.addModel(fireworksConfig(id, fireworksKey, lane?.image ? 0.7 : 0.2, lane ?? visionLane));
      }
      this.imageReady = Promise.all([this.hideUndeployedFireworksImages(fireworksKey), refreshFireworksImageRates(this.registry.list())]).then(() => undefined);
    }

    // Hugging Face Inference Providers uses an OpenAI-compatible router.
    // Register only known chat models with an explicitly selected provider;
    // the key is server-side and these routes remain unavailable when unset.
    const huggingFaceKey = process.env.HUGGINGFACE_API_KEY?.trim() || process.env.HF_TOKEN?.trim();
    if (huggingFaceKey) {
      const ids = (process.env.HUGGINGFACE_MODELS ?? "zai-org/GLM-5.3:deepinfra,zai-org/GLM-5.3-Flash:deepinfra,moonshotai/Kimi-K2.7-Code:deepinfra")
        .split(",").map((id) => id.trim()).filter(Boolean);
      const verification: Promise<void>[] = [];
      for (const id of [...new Set(ids)]) {
        const config = openAiCompatibleConfig("hf", "Hugging Face", huggingFaceEndpoint(), id, huggingFaceKey, 0.2, 8192);
        config.providerName = "huggingface";
        config.routingVerification = { status: "pending", reason: "Hugging Face capability verification pending" };
        config.streaming = false;
        config.capabilities = { chat: false, code: false, agent: false, tools: false, vision: false, embeddings: false, completion: false, image: false };
        this.addModel(config);
        verification.push(verifyHuggingFace(config));
      }
      this.huggingFaceReady = Promise.all([this.huggingFaceReady, ...verification]).then(() => undefined);
    }

    // Mistral (Small 4 utility, Codestral, Medium/Large, GLM 5.3) and OpenRouter
    // (DeepSeek V3.2, MiniMax M2.5): cheap tiers of the routing policy.
    const mistralKey = process.env.MISTRAL_API_KEY?.trim();
    if (mistralKey) {
      const endpoint = process.env.MISTRAL_BASE_URL?.trim() || "https://api.mistral.ai";
      const extra = (process.env.MISTRAL_MODELS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((id) => ({ id, context: 128000, temperature: 0.3 }));
      for (const m of [...MISTRAL_MODELS, ...extra]) this.addModel(openAiCompatibleConfig("mistral", "Mistral", endpoint, m.id, mistralKey, m.temperature, m.context));
    }
    const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
    if (openRouterKey) {
      const endpoint = process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api";
      const extra = (process.env.OPENROUTER_MODELS ?? "").split(",").map((x) => x.trim()).filter(Boolean).map((id) => ({ id, context: 128000, temperature: 0.3 }));
      for (const m of [...OPENROUTER_MODELS, ...extra]) this.addModel(openAiCompatibleConfig("openrouter", "OpenRouter", endpoint, m.id, openRouterKey, m.temperature, m.context));
    }

    // Nebius Token Factory (OpenAI-compatible): a global provider. The curated
    // set (models/modelEquivalents.ts) registers now and is what the model menu
    // shows; the routing policy uses them by role and as the second provider
    // for models Fireworks also serves. The rest of the account's catalog is
    // registered in the background as "more models" (found by search only).
    const nebiusKey = process.env.NEBIUS_API_KEY?.trim();
    if (nebiusKey) {
      for (const m of NEBIUS_CURATED) this.addModel(openAiCompatibleConfig("nebius", "Nebius", nebiusEndpoint(), m.id, nebiusKey, m.temperature, m.context));
      for (const id of nebiusModelList()) if (!this.registry.get(`nebius:${id}`)) this.addModel(openAiCompatibleConfig("nebius", "Nebius", nebiusEndpoint(), id, nebiusKey, 0.2, 131072));
      const embed = embedModelChoice();
      if (embed?.id === `nebius:${NEBIUS_EMBED_MODEL}`) {
        this.addModel({
          ...openAiCompatibleConfig("nebius", "Nebius", nebiusEndpoint(), NEBIUS_EMBED_MODEL, nebiusKey, 0, 32768),
          maxOutputTokens: 1,
          streaming: false,
          capabilities: { chat: false, code: false, agent: false, tools: false, vision: false, embeddings: true, completion: false, image: false },
        });
      }
      void this.refreshNebiusCatalog(nebiusKey);
    }

    const geminiKey = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)?.trim();
    if (geminiKey) {
      const ids = (process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL ?? "gemini-3.8-flash,gemini-2.5-flash-lite")
        .split(",").map((s) => s.trim()).filter(Boolean);
      for (const id of [...new Set(ids)]) this.addModel(geminiConfig(id, geminiKey, 0.3));
    }

    const ollamaId = process.env.OLLAMA_MODEL?.trim();
    if (ollamaId) {
      this.addModel({
        id: ollamaId,
        name: `${ollamaId} (Ollama)`,
        provider: "ollama",
        endpoint: process.env.OLLAMA_HOST?.trim() || "http://127.0.0.1:11434",
        contextWindow: 32768,
        maxOutputTokens: 4096,
        defaultTemperature: 0.7,
        defaultTopP: 1,
        streaming: true,
        capabilities: {
          chat: true,
          code: true,
          agent: true,
          tools: true,
          vision: false,
          embeddings: false,
          completion: true,
          image: false,
        },
      });
    }

    const ciChat = ciKey ? `ci:${process.env.CHEAPER_INFERENCE_CHAT_MODEL?.trim() || "gpt-5.6-luna"}` : "";
    const ciCode = ciKey ? `ci:${process.env.CHEAPER_INFERENCE_CODE_MODEL?.trim() || "gpt-5.6-terra"}` : "";

    const ciImage = ciKey ? `ci:${process.env.CHEAPER_INFERENCE_IMAGE_MODEL?.trim() || "nano-banana"}` : "";
    const defaultProvider = process.env.ORVYN_DEFAULT_MODEL_PROVIDER?.trim().toLowerCase();
    const preferCi = Boolean(ciKey && ["cheaper_inference", "cheaper-inference", "ci"].includes(defaultProvider || ""));

    // An explicit provider preference prevents an expired secondary key from
    // adding a failed request before every answer. Embeddings can still stay
    // on OpenAI while chat and agent roles use Cheaper Inference.
    if (preferCi) {
      this.router.setDefaultOverride("chat", ciChat);
      this.router.setDefaultOverride("code", ciCode || ciChat);
      this.router.setDefaultOverride("completion", ciChat);
      this.router.setDefaultOverride("agent", ciCode || ciChat);
      this.router.setDefaultOverride("planner", ciCode || ciChat);
      this.router.setDefaultOverride("reviewer", ciCode || ciChat);
      this.router.setDefaultOverride("executor", ciChat);
      this.router.setDefaultOverride("vision", ciChat);
      if (ciImage) this.router.setDefaultOverride("image", ciImage);
      if (openaiKey) this.router.setDefaultOverride("embedding", process.env.OPENAI_EMBED_MODEL?.trim() || "text-embedding-3-small");
    } else if (openaiKey) {
      this.router.setDefaultOverride("chat", chatId);
      this.router.setDefaultOverride("code", codeId);
      this.router.setDefaultOverride("agent", codeId);
      this.router.setDefaultOverride("planner", codeId);
      this.router.setDefaultOverride("reviewer", codeId);
      this.router.setDefaultOverride("executor", ciChat || chatId);
      this.router.setDefaultOverride("completion", ciChat || chatId);
      this.router.setDefaultOverride("embedding", process.env.OPENAI_EMBED_MODEL?.trim() || "text-embedding-3-small");
      this.router.setDefaultOverride("vision", codeId);
      if (ciImage) this.router.setDefaultOverride("image", ciImage);
    } else if (ciKey) {
      this.router.setDefaultOverride("chat", ciChat);
      this.router.setDefaultOverride("code", ciCode || ciChat);
      this.router.setDefaultOverride("completion", ciChat);
      this.router.setDefaultOverride("agent", ciCode || ciChat);
      this.router.setDefaultOverride("planner", ciCode || ciChat);
      this.router.setDefaultOverride("reviewer", ciCode || ciChat);
      this.router.setDefaultOverride("executor", ciChat);
      this.router.setDefaultOverride("vision", ciChat);
      if (ciImage) this.router.setDefaultOverride("image", ciImage);
    } else if (ollamaId) {
      this.router.setDefaultOverride("chat", ollamaId);
      this.router.setDefaultOverride("code", ollamaId);
      this.router.setDefaultOverride("completion", ollamaId);
      this.router.setDefaultOverride("agent", ollamaId);
      this.router.setDefaultOverride("planner", ollamaId);
      this.router.setDefaultOverride("reviewer", ollamaId);
      this.router.setDefaultOverride("executor", ollamaId);
    } else if (nebiusKey) {
      const fast = "nebius:zai-org/GLM-5.3-Flash";
      const coder = "nebius:moonshotai/Kimi-K2.7-Code";
      for (const task of ["chat", "completion", "executor"] as const) this.router.setDefaultOverride(task, fast);
      for (const task of ["code", "agent", "planner", "reviewer"] as const) this.router.setDefaultOverride(task, coder);
    } else {
      this.router.setDefaultOverride("chat", "orvyn-mock");
      this.router.setDefaultOverride("code", "orvyn-mock");
      this.router.setDefaultOverride("completion", "orvyn-mock");
      this.router.setDefaultOverride("agent", "orvyn-mock");
      this.router.setDefaultOverride("planner", "orvyn-mock");
      this.router.setDefaultOverride("reviewer", "orvyn-mock");
      this.router.setDefaultOverride("executor", "orvyn-mock");
    }

    // --- ORVYN Intelligence model gateway presets (applied LAST so they win) ---

    // Coding worker: DeepSeek when a key exists. The executor role points at
    // the flash tier; pro is available for manual routing. No agent code ever
    // names these models — they only flow through the router.
    const dsKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (dsKey) {
      const dsEndpoint = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
      const flash = process.env.DEEPSEEK_CODE_MODEL?.trim() || "deepseek-flash";
      const pro = process.env.DEEPSEEK_PRO_MODEL?.trim() || "deepseek-v4-pro";
      this.addModel(deepseekConfig(flash, dsKey, dsEndpoint, 0.2));
      if (pro !== flash) this.addModel(deepseekConfig(pro, dsKey, dsEndpoint, 0.2));
      if (process.env.DEEPSEEK_EXECUTOR_OVERRIDE_ENABLED !== "0") this.router.setDefaultOverride("executor", flash);
    }

    // ORION is an agent identity, not a model. ORION_MODEL_ID (with legacy ASTRA_MODEL_ID alias),
    // a registered model id, decides which model plans and reviews; without it,
    // the chains above stand.
    const orchestratorModel =
      process.env.ORION_MODEL_ID?.trim() || process.env.ASTRA_MODEL_ID?.trim() || process.env.ORCHESTRATOR_MODEL?.trim();
    if (orchestratorModel) {
      if (this.registry.get(orchestratorModel)) {
        this.router.setOverride("planner", orchestratorModel);
        this.router.setOverride("reviewer", orchestratorModel);
      } else {
        console.warn(
          `ORION_MODEL_ID/ORCHESTRATOR_MODEL="${orchestratorModel}" does not match any registered model id; keeping default planner/reviewer routing.`
        );
      }
    }

    // Reasoning-effort support is DECLARED, never guessed: ORVYN_REASONING_EFFORT_MODELS
    // lists ids whose provider accepts the OpenAI-style reasoning_effort field
    // (append "+max" when the provider also honors a level above "high").
    // Models not listed expose no reasoning control — the composer shows Auto only.
    // Embeddings for memory and code search: an explicit choice wins
    // (ORVYN_EMBED_MODEL, e.g. nebius:Qwen/Qwen3-Embedding-8B). It is opt-in
    // because a different embedder means a different vector space; the
    // index for the new model is kept separately and rebuilt.
    const embedChoice = embedModelChoice();
    if (embedChoice && this.registry.get(embedChoice.id)?.config.capabilities.embeddings) {
      this.router.setDefaultOverride("embedding", embedChoice.id);
    }

    const effortDeclared = (process.env.ORVYN_REASONING_EFFORT_MODELS ?? "")
      .split(",").map((x) => x.trim()).filter(Boolean);
    for (const entry of effortDeclared) {
      const [id, flag] = entry.split(/\+/, 2);
      const provider = this.registry.get(id.trim());
      if (!provider) continue;
      provider.config.reasoningControl = {
        param: "reasoning_effort",
        levels: flag === "max"
          ? { fast: "low", standard: "medium", deep: "high", max: "xhigh" }
          : { fast: "low", standard: "medium", deep: "high" },
      };
    }
    const nebius = this.registry.list().filter((p) => p.config.id.startsWith("nebius:"));
    const fireworks = this.registry.list().filter((p) => p.config.providerName === "fireworks");
    const writing = this.registry.get(`fw:${FIREWORKS_WRITING_MODEL}`);
    if (writing) {
      writing.config.routingVerification = { status: "pending", reason: "Fireworks writing route awaiting live verification" };
      this.huggingFaceReady = Promise.all([this.huggingFaceReady, verifyFireworksWriting(writing.config)]).then(() => undefined);
    }
    const deepseek = this.registry.list().filter((p) => p.config.providerName === "deepseek");
    this.huggingFaceReady = Promise.all([this.huggingFaceReady, refreshOpenAIRates(this.registry.list()), refreshOpenRouterRates(this.registry.list()), ...deepseek.map((p) => refreshDeepSeekRates(p.config)), ...(nebius.length ? [refreshNebiusRates(nebius)] : []), ...(fireworks.length ? [refreshFireworksRates(fireworks)] : [])]).then(() => undefined);
    if (this.registry.list().some((p) => p.config.apiKey)) {
      const refresh = setInterval(() => {
        this.imageReady = refreshFireworksImageRates(this.registry.list());
        this.huggingFaceReady = Promise.all([
          refreshOpenAIRates(this.registry.list()), refreshOpenRouterRates(this.registry.list()),
          this.refreshCheaperInferenceCatalog(),
          ...deepseek.map((p) => refreshDeepSeekRates(p.config)),
          ...this.registry.list().filter((p) => p.config.providerName === "huggingface").map((p) => verifyHuggingFace(p.config)),
          ...(nebius.length ? [refreshNebiusRates(nebius)] : []),
          ...(fireworks.length ? [refreshFireworksRates(fireworks)] : []),
          ...(writing ? [verifyFireworksWriting(writing.config)] : []),
        ]).then(() => undefined);
      }, 5 * 60_000);
      refresh.unref();
    }
    const retired = this.registry.get("fw:accounts/fireworks/models/kimi-k2p7-code");
    if (retired) retired.config.routingVerification = { status: "failed", reason: "Fireworks Kimi K2.7 Code serverless retired 2026-09-25; configure an explicit on-demand deployment instead" };
  }

  addModel(config: ModelConfig, source: "platform" | "user" = "platform"): AIModelProvider {
    config.billingRequired = source === "platform" && process.env.ORVYN_ENFORCE_CREDITS !== "false" && (process.env.ORVYN_ENFORCE_CREDITS === "true" || process.env.ORVYN_CLOUD_MODE === "true");
    if (source === "platform") applyConfiguredRate(config);
    let provider: AIModelProvider;
    switch (config.provider) {
      case "ollama":
        provider = new OllamaAdapter(config);
        break;
      case "vllm":
      case "llamacpp":
      case "openai-compatible":
      case "custom-http":
        provider = new OpenAICompatibleAdapter(config);
        break;
      case "mock":
        provider = new MockAdapter(config);
        break;
      // Typed pending adapters: registrable and visible in the Model Manager,
      // but every inference call throws a clear "not configured" error.
      case "anthropic":
        provider = new AnthropicAdapter(config);
        break;
      case "google":
        provider = new GoogleAdapter(config);
        break;
      default:
        throw new Error(`Unknown model provider "${config.provider}"`);
    }
    // Metering proxy: every generate/stream/image call on any registered
    // model produces a usage event, regardless of which code path calls it.
    const metered = this.usage.wrap(provider);
    this.registry.register(metered);
    if (source === "user") this.userModelIds.add(config.id);
    else this.userModelIds.delete(config.id);
    return metered;
  }

  removeModel(id: string): void {
    this.registry.unregister(id);
    this.userModelIds.delete(id);
    if (this.preferredModel === id) this.preferredModel = null;
  }

  list() {
    return this.registry.list().map((p) => ({
      ...p.config,
      apiKey: p.config.apiKey ? "configured" : undefined,
      /** False for a provider's long tail: callable and searchable, not listed in the menu. */
      featured: !this.moreModels.has(p.config.id),
    }));
  }

  /** Production role → model map. Mock is never treated as production. */
  roles() {
    const tasks = ["chat", "code", "agent", "planner", "reviewer", "executor", "image", "completion"] as const;
    return tasks.map((task) => {
      try {
        const provider = this.router.resolve(task);
        const id = provider.config.id;
        return {
          task,
          modelId: id,
          name: provider.config.name,
          production: id !== "orvyn-mock",
        };
      } catch (err: any) {
        return { task, modelId: null, name: null, production: false, error: err?.message ?? "unconfigured" };
      }
    });
  }

  async healthCheckAll() {
    const results = await Promise.all(
      this.registry.list().map(async (p) => ({
        id: p.config.id,
        ...(await p.healthCheck()),
      }))
    );
    return results;
  }

  /**
   * Checks the curated Nebius set against the account's catalog (a curated
   * model this account cannot call is skipped by routing) and registers the
   * other chat models as "more models" (embeddings and image models skipped).
   */
  async refreshNebiusCatalog(apiKey: string): Promise<number> {
    try {
      const res = await fetch(`${nebiusEndpoint()}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.warn(JSON.stringify({ event: "nebius.catalog.failed", status: res.status }));
        return 0;
      }
      const data = await res.json();
      const rows: { id?: string }[] = Array.isArray(data.data) ? data.data : [];
      let added = 0;
      for (const row of rows) {
        const id = String(row?.id ?? "");
        if (!id || /embed|bge|e5-|clip|flux|stable-diffusion|sdxl|whisper|tts|guard|rerank/i.test(id)) continue;
        if (this.registry.get(`nebius:${id}`)) continue;
        this.addModel(openAiCompatibleConfig("nebius", "Nebius", nebiusEndpoint(), id, apiKey, 0.2, 131072));
        this.moreModels.add(`nebius:${id}`);
        added++;
      }
      const listed = new Set(rows.map((r) => String(r?.id ?? "")));
      const missing = rows.length > 0 ? NEBIUS_CURATED.map((m) => m.id).filter((id) => !listed.has(id)) : [];
      for (const id of missing) markModelUnavailable(`nebius:${id}`, "not in this Nebius account's model catalog");
      console.log(JSON.stringify({ event: "nebius.catalog", models: rows.length, added, curatedMissing: missing }));
      return added;
    } catch (err: any) {
      console.warn(JSON.stringify({ event: "nebius.catalog.failed", error: String(err?.message ?? err).slice(0, 120) }));
      return 0;
    }
  }

  /** Kontext stays registered only when this Fireworks account actually deploys it. */
  async hideUndeployedFireworksImages(apiKey: string): Promise<void> {
    try {
      const endpoint = (process.env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference").replace(/\/v1\/?$/, "");
      const res = await fetch(`${endpoint}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!res.ok) return;
      const data = await res.json();
      const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
      const ids = new Set(rows.map((row: { id?: string; name?: string } | string) => typeof row === "string" ? row : String(row?.id || row?.name || "")));
      for (const provider of this.registry.list()) {
        if (!provider.config.id.startsWith("fw:") || !provider.config.capabilities.image) continue;
        const wire = provider.config.apiModelId || "";
        if (!ids.has(wire)) provider.config.capabilities.image = false;
      }
    } catch {
      // Leave the certified registration in place if the catalog cannot be read.
    }
  }

  /** Stamp live Cheaper Inference catalog flags (tools/vision/image) onto seeded models. */
  async refreshCheaperInferenceCatalog(): Promise<void> {
    const key = process.env.CHEAPER_INFERENCE_API_KEY?.trim();
    if (!key) return;
    try {
      const res = await fetch(`${cheaperInferenceEndpoint()}/v1/models`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) return;
      const data = await res.json();
      const items = Array.isArray(data.data) ? data.data : [];
      const checked = Date.parse(data.pricing_checked_at);
      if (!Number.isFinite(checked) || checked > Date.now() + 60_000 || Date.now() - checked > 60 * 60_000) return;
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) continue;
        const caps = item.capabilities ?? {};
        const isImage = item.type === "image" && Array.isArray(item.supported_endpoints) && item.supported_endpoints.includes("/v1/images/generations");
        let provider = this.registry.get(`ci:${id}`);
        if (!provider && isImage) {
          provider = this.addModel(cheaperInferenceConfig(id, key, 0.7, cheaperInferenceEndpoint(), "image"));
        }
        if (!provider) continue;
        provider.config.rate = cheaperInferenceRate(item, `${cheaperInferenceEndpoint()}/v1/models`);
        if (isImage && item.pricing?.currency === "USD") {
          const budget = Number(process.env.ORVYN_IMAGE_SETTLEMENT_BUDGET_USD ?? "0.50");
          if (Number.isFinite(budget) && budget > 0) provider.config.imageSettlementBudgetUsd = budget;
          if (item.pricing.media_unit === "image" && item.pricing.image_pricing_unit === "image" && Number(item.pricing.media_unit_price) > 0) {
            const now = Date.now();
            provider.config.imageRate = { usdPerImage: Number(item.pricing.media_unit_price), premium: false, source: `${cheaperInferenceEndpoint()}/v1/models`, verifiedAt: now, expiresAt: now + 10 * 60_000 };
          }
        }
        const isText = item.type === "text" || (!isImage && item.type !== "video");
        provider.config.capabilities.chat = isText;
        provider.config.capabilities.code = isText;
        provider.config.capabilities.agent = isText;
        provider.config.capabilities.tools = isText;
        provider.config.capabilities.vision = Boolean(caps.vision);
        provider.config.capabilities.image = isImage;
        provider.config.capabilities.imageEditing = Boolean(caps.image_editing || caps.image_edit || caps.edit);
        provider.config.capabilities.completion = isText;
        provider.config.streaming = Boolean(caps.streaming);
        if (typeof item.context_length === "number") provider.config.contextWindow = item.context_length;
      }
    } catch {
      // Catalog refresh is best-effort; seeded defaults still work.
    }
  }
}

export const modelService = new ModelService();
