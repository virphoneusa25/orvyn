// apps/backend/src/services/ModelService.ts
import "../loadEnv";
import {
  ModelRegistry,
  ModelRouter,
  ModelConfig,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  MockAdapter,
  AIModelProvider,
} from "@orvyn/ai-core";

function openaiDisplayName(id: string): string {
  if (id === "gpt-4o") return "OpenAI GPT-4o";
  if (id === "gpt-4o-mini") return "OpenAI GPT-4o mini";
  return `OpenAI ${id}`;
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
    },
  };
}

// NOTE: Phase 1 persists model configs in memory only.
// Phase 7 (production) should move this to Postgres via Prisma (see docs/architecture.md).
export class ModelService {
  public registry = new ModelRegistry();
  public router = new ModelRouter(this.registry);

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
        },
      });
    }

    // OpenAI is the default when a key is present (see ORVYN-OpenAI-Setup).
    // Ollama stays registered so Model Manager can switch later.
    if (openaiKey) {
      this.router.setOverride("chat", chatId);
      this.router.setOverride("completion", chatId);
      this.router.setOverride("code", codeId);
      this.router.setOverride("agent", codeId);
    } else if (ollamaId) {
      this.router.setOverride("chat", ollamaId);
      this.router.setOverride("code", ollamaId);
      this.router.setOverride("completion", ollamaId);
      this.router.setOverride("agent", ollamaId);
    } else {
      this.router.setOverride("chat", "orvyn-mock");
      this.router.setOverride("code", "orvyn-mock");
      this.router.setOverride("completion", "orvyn-mock");
      this.router.setOverride("agent", "orvyn-mock");
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
      default:
        throw new Error(`Unknown model provider "${config.provider}"`);
    }
    this.registry.register(provider);
    return provider;
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

  async healthCheckAll() {
    const results = await Promise.all(
      this.registry.list().map(async (p) => ({
        id: p.config.id,
        ...(await p.healthCheck()),
      }))
    );
    return results;
  }
}

export const modelService = new ModelService();
