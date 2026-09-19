// packages/ai-core/src/adapters/pendingAdapter.ts
//
// Typed placeholders for providers whose native wire protocol is not
// implemented yet. They satisfy AIModelProvider so they can be registered and
// shown in the Model Manager as "Pending", but every inference call throws a
// clear, actionable error instead of silently degrading or faking output.

import { AIChunk, AIModelProvider, AIRequest, AIResponse, ModelConfig, ModelStatus } from "../types";

export class PendingProviderAdapter implements AIModelProvider {
  constructor(
    public readonly config: ModelConfig,
    protected readonly reason: string
  ) {}

  protected fail(): never {
    throw new Error(`${this.config.name} is not configured: ${this.reason}`);
  }

  async generate(_request: AIRequest): Promise<AIResponse> {
    this.fail();
  }

  // eslint-disable-next-line require-yield
  async *stream(_request: AIRequest): AsyncIterable<AIChunk> {
    this.fail();
  }

  async healthCheck(): Promise<{ status: ModelStatus; latencyMs?: number; error?: string }> {
    return { status: "offline", error: `Pending — ${this.reason}` };
  }

  supportsTools(): boolean {
    return false;
  }

  supportsVision(): boolean {
    return false;
  }
}

export class AnthropicAdapter extends PendingProviderAdapter {
  constructor(config: ModelConfig) {
    super(
      config,
      "the native Anthropic adapter is pending. Set ANTHROPIC_API_KEY and use an OpenAI-compatible proxy endpoint meanwhile."
    );
  }
}

export class GoogleAdapter extends PendingProviderAdapter {
  constructor(config: ModelConfig) {
    super(
      config,
      "the native Google (Gemini) adapter is pending. Set GOOGLE_API_KEY and use an OpenAI-compatible proxy endpoint meanwhile."
    );
  }
}
