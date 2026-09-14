// packages/ai-core/src/registry.ts
import { AIModelProvider } from "./types";

export class ModelRegistry {
  private providers = new Map<string, AIModelProvider>();

  register(provider: AIModelProvider): void {
    this.providers.set(provider.config.id, provider);
  }

  unregister(modelId: string): void {
    this.providers.delete(modelId);
  }

  get(modelId: string): AIModelProvider | undefined {
    return this.providers.get(modelId);
  }

  list(): AIModelProvider[] {
    return Array.from(this.providers.values());
  }

  findByCapability(capability: keyof AIModelProvider["config"]["capabilities"]): AIModelProvider[] {
    return this.list().filter((p) => p.config.capabilities[capability]);
  }
}
