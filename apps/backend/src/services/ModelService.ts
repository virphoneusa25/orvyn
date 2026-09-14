// apps/backend/src/services/ModelService.ts
import {
  ModelRegistry,
  ModelRouter,
  ModelConfig,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  MockAdapter,
  AIModelProvider,
} from "@viride/ai-core";

// NOTE: Phase 1 persists model configs in memory only.
// Phase 7 (production) should move this to Postgres via Prisma (see docs/architecture.md).
export class ModelService {
  public registry = new ModelRegistry();
  public router = new ModelRouter(this.registry);

  constructor() {
    // Seed with a mock model so the IDE is runnable with zero config.
    this.addModel({
      id: "viride-mock",
      name: "VirIDE Mock (no model configured)",
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
    this.router.setOverride("chat", "viride-mock");
    this.router.setOverride("code", "viride-mock");
    this.router.setOverride("completion", "viride-mock");
    this.router.setOverride("agent", "viride-mock");
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
    return this.registry.list().map((p) => p.config);
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
