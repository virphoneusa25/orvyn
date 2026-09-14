// packages/ai-core/src/adapters/ollamaAdapter.ts
import { AIModelProvider, AIRequest, AIResponse, AIChunk, ModelConfig, ModelStatus } from "../types";

export class OllamaAdapter implements AIModelProvider {
  constructor(public readonly config: ModelConfig) {}

  async generate(request: AIRequest): Promise<AIResponse> {
    const res = await fetch(`${this.config.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.id,
        messages: request.messages,
        stream: false,
        options: {
          temperature: request.temperature ?? this.config.defaultTemperature,
          top_p: request.topP ?? this.config.defaultTopP,
        },
      }),
    });
    if (!res.ok) throw new Error(`Ollama model "${this.config.id}" HTTP ${res.status}`);
    const data = await res.json();
    return {
      content: data.message?.content ?? "",
      finishReason: data.done ? "stop" : "length",
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    const res = await fetch(`${this.config.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.config.id,
        messages: request.messages,
        stream: true,
        options: {
          temperature: request.temperature ?? this.config.defaultTemperature,
          top_p: request.topP ?? this.config.defaultTopP,
        },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama stream failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const json = JSON.parse(line);
          if (json.message?.content) yield { delta: json.message.content, done: false };
          if (json.done) {
            yield { delta: "", done: true };
            return;
          }
        } catch {
          // skip malformed line
        }
      }
    }
    yield { delta: "", done: true };
  }

  async embed(input: string): Promise<number[]> {
    const res = await fetch(`${this.config.endpoint}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.id, prompt: input }),
    });
    if (!res.ok) throw new Error(`Ollama embeddings HTTP ${res.status}`);
    const data = await res.json();
    return data.embedding ?? [];
  }

  async healthCheck(): Promise<{ status: ModelStatus; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.config.endpoint}/api/tags`);
      if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
      return { status: "online", latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: "offline", error: err.message };
    }
  }

  supportsTools(): boolean {
    return this.config.capabilities.agent;
  }

  supportsVision(): boolean {
    return this.config.capabilities.vision;
  }
}
