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
} from "@orvyn/ai-core";
import { UsageService } from "./UsageService";
import { CERTIFIED_MODELS } from "../models/certifiedModels";

function openaiDisplayName(id: string): string {
  if (id === "gpt-4o") return "OpenAI GPT-4o";
  if (id === "gpt-4o-mini") return "OpenAI GPT-4o mini";
  return `OpenAI ${id}`;
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
  return [...new Set([chatId, codeId, ...extra, ...certified])];
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
    endpoint: (process.env.FIREWORKS_BASE_URL?.trim() || "https://api.fireworks.ai/inference").replace(/\/v1\/?$/, ""),
    apiKey,
    contextWindow: lane?.contextWindow ?? 128000,
    maxOutputTokens: image ? 1 : 8192,
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
  public router = new ModelRouter(this.registry);
  /** Server-side usage metering — every provider registered here is wrapped. */
  public usage = new UsageService();

  constructor() {
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
      void this.refreshCheaperInferenceCatalog();
    }

    const fireworksKey = process.env.FIREWORKS_API_KEY?.trim();
    if (fireworksKey) {
      const certified = CERTIFIED_MODELS.filter((m) => m.provider === "fireworks").map((m) => m.apiModelId);
      const extra = (process.env.FIREWORKS_MODELS ?? process.env.FIREWORKS_MODEL ?? "")
        .split(",").map((s) => s.trim()).filter(Boolean);
      for (const id of [...new Set([...certified, ...extra])]) {
        const lane = CERTIFIED_MODELS.find((m) => m.apiModelId === id);
        this.addModel(fireworksConfig(id, fireworksKey, lane?.image ? 0.7 : 0.2, lane));
      }
    }

    const geminiKey = (process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY)?.trim();
    if (geminiKey) {
      const ids = (process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite")
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

    // OpenAI stays the default when a key is present. Cheaper Inference is
    // registered alongside it; tab-complete and images use the cheaper models.
    if (openaiKey) {
      this.router.setOverride("chat", chatId);
      this.router.setOverride("code", codeId);
      this.router.setOverride("agent", codeId);
      this.router.setOverride("planner", codeId);
      this.router.setOverride("reviewer", codeId);
      this.router.setOverride("executor", ciChat || chatId);
      this.router.setOverride("completion", ciChat || chatId);
      this.router.setOverride("embedding", process.env.OPENAI_EMBED_MODEL?.trim() || "text-embedding-3-small");
      this.router.setOverride("vision", codeId);
      if (ciImage) this.router.setOverride("image", ciImage);
    } else if (ciKey) {
      this.router.setOverride("chat", ciChat);
      this.router.setOverride("code", ciCode || ciChat);
      this.router.setOverride("completion", ciChat);
      this.router.setOverride("agent", ciCode || ciChat);
      this.router.setOverride("planner", ciCode || ciChat);
      this.router.setOverride("reviewer", ciCode || ciChat);
      this.router.setOverride("executor", ciChat);
      this.router.setOverride("vision", ciChat);
      if (ciImage) this.router.setOverride("image", ciImage);
    } else if (ollamaId) {
      this.router.setOverride("chat", ollamaId);
      this.router.setOverride("code", ollamaId);
      this.router.setOverride("completion", ollamaId);
      this.router.setOverride("agent", ollamaId);
      this.router.setOverride("planner", ollamaId);
      this.router.setOverride("reviewer", ollamaId);
      this.router.setOverride("executor", ollamaId);
    } else {
      this.router.setOverride("chat", "orvyn-mock");
      this.router.setOverride("code", "orvyn-mock");
      this.router.setOverride("completion", "orvyn-mock");
      this.router.setOverride("agent", "orvyn-mock");
      this.router.setOverride("planner", "orvyn-mock");
      this.router.setOverride("reviewer", "orvyn-mock");
      this.router.setOverride("executor", "orvyn-mock");
    }

    // --- ORVYN Intelligence model gateway presets (applied LAST so they win) ---

    // Coding worker: DeepSeek when a key exists. The executor role points at
    // the flash tier; pro is available for manual routing. No agent code ever
    // names these models — they only flow through the router.
    const dsKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (dsKey) {
      const dsEndpoint = process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com";
      const flash = process.env.DEEPSEEK_CODE_MODEL?.trim() || "deepseek-v4-flash";
      const pro = process.env.DEEPSEEK_PRO_MODEL?.trim() || "deepseek-v4-pro";
      this.addModel(deepseekConfig(flash, dsKey, dsEndpoint, 0.2));
      if (pro !== flash) this.addModel(deepseekConfig(pro, dsKey, dsEndpoint, 0.2));
      this.router.setOverride("executor", flash);
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
  }

  addModel(config: ModelConfig): AIModelProvider {
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
    return metered;
  }

  removeModel(id: string): void {
    this.registry.unregister(id);
  }

  list() {
    return this.registry.list().map((p) => ({
      ...p.config,
      apiKey: p.config.apiKey ? "configured" : undefined,
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
      for (const item of items) {
        const id = typeof item.id === "string" ? item.id : "";
        if (!id) continue;
        const caps = item.capabilities ?? {};
        const isImage = item.type === "image" || Boolean(caps.image_generation);
        let provider = this.registry.get(`ci:${id}`);
        if (!provider && isImage) {
          provider = this.addModel(cheaperInferenceConfig(id, key, 0.7, cheaperInferenceEndpoint(), "image"));
        }
        if (!provider) continue;
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
