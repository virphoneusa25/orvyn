// packages/ai-core/src/adapters/openaiCompatibleAdapter.ts
//
// Many self-hosted servers (vLLM, llama.cpp's server, LocalAI, text-generation-webui,
// and plenty of "custom model APIs") all expose the same /v1/chat/completions wire
// shape. This adapter speaks THAT WIRE FORMAT ONLY — it is not tied to any vendor,
// it just happens to be a widely-implemented open format for self-hosted inference.
import {
  AIModelProvider,
  AIRequest,
  AIResponse,
  AIChunk,
  ModelConfig,
  ModelStatus,
} from "../types";

export class OpenAICompatibleAdapter implements AIModelProvider {
  constructor(public readonly config: ModelConfig) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private openaiMessages(request: AIRequest) {
    return request.messages.map((m) => {
      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          })),
        };
      }
      return { role: m.role, content: m.content };
    });
  }

  private openaiTools(request: AIRequest) {
    if (!request.tools || request.tools.length === 0) return undefined;
    return request.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.config.id,
        messages: this.openaiMessages(request),
        temperature: request.temperature ?? this.config.defaultTemperature,
        top_p: request.topP ?? this.config.defaultTopP,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
        tools: this.openaiTools(request),
        stream: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`Model "${this.config.id}" returned HTTP ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      toolCalls: choice?.message?.tool_calls?.map((tc: any) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function?.arguments ?? "{}");
        } catch {
          args = {};
        }
        return { id: tc.id, name: tc.function?.name, arguments: args };
      }),
      finishReason: choice?.finish_reason === "tool_calls" ? "tool_call" : (choice?.finish_reason ?? "stop"),
      usage: data.usage
        ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens }
        : undefined,
    };
  }

  async *stream(request: AIRequest): AsyncIterable<AIChunk> {
    const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.config.id,
        messages: this.openaiMessages(request),
        temperature: request.temperature ?? this.config.defaultTemperature,
        top_p: request.topP ?? this.config.defaultTopP,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Model "${this.config.id}" stream failed: HTTP ${res.status}`);
    }

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
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          yield { delta: "", done: true };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content ?? "";
          if (delta) yield { delta, done: false };
        } catch {
          // Ignore malformed SSE fragments rather than crashing the stream.
        }
      }
    }
    yield { delta: "", done: true };
  }

  async healthCheck(): Promise<{ status: ModelStatus; latencyMs?: number; error?: string }> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.config.endpoint}/v1/models`, { headers: this.headers() });
      if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
      return { status: "online", latencyMs: Date.now() - start };
    } catch (err: any) {
      return { status: "offline", error: err.message };
    }
  }

  supportsTools(): boolean {
    return this.config.capabilities.agent || this.config.capabilities.chat;
  }

  supportsVision(): boolean {
    return this.config.capabilities.vision;
  }
}
