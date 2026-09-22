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

  private wireModel(): string {
    return this.config.apiModelId || this.config.id.replace(/^ci:/, "");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private openaiMessages(request: AIRequest) {
    return request.messages.map((m) => {
      // Attachments: images become multimodal content parts (vision models
      // only); text files are folded into the prompt text so they still work
      // on non-vision models rather than being silently dropped.
      if (m.attachments && m.attachments.length > 0 && (m.role === "user" || m.role === "system")) {
        const images = m.attachments.filter((a) => a.kind === "image" && a.b64);
        const files = m.attachments.filter((a) => a.kind === "file" && a.content);

        const textParts: string[] = [];
        for (const f of files) {
          textParts.push(`--- attached file: ${f.name} ---\n${f.content}`);
        }
        textParts.push(m.content);
        const text = textParts.join("\n\n");

        if (images.length > 0 && this.config.capabilities.vision) {
          return {
            role: m.role,
            content: [
              { type: "text", text },
              ...images.map((img) => ({
                type: "image_url",
                image_url: { url: `data:${img.mediaType ?? "image/png"};base64,${img.b64}` },
              })),
            ],
          };
        }
        const note = images.length > 0
          ? `\n\n[${images.length} image(s) attached but this model has no vision capability]`
          : "";
        return { role: m.role, content: text + note };
      }

      if (m.role === "tool") {
        return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          // Thinking models (DeepSeek) 400 the whole request if their own
          // reasoning_content is not echoed back on prior assistant turns.
          ...(m.reasoningContent ? { reasoning_content: m.reasoningContent } : {}),
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments ?? {}) },
          })),
        };
      }
      if (m.role === "assistant" && m.reasoningContent) {
        return { role: "assistant", content: m.content, reasoning_content: m.reasoningContent };
      }
      if (m.images && m.images.length > 0) {
        if (this.config.capabilities.vision) {
          return {
            role: m.role,
            content: [
              ...(m.content ? [{ type: "text", text: m.content }] : []),
              ...m.images.map((img) => ({
                type: "image_url",
                image_url: { url: img.url },
              })),
            ],
          };
        }
        return {
          role: m.role,
          content: `${m.content}\n\n[${m.images.length} image(s) attached but this model has no vision capability]`,
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

  /**
   * Resolves the reasoning-effort wire field for a request. Only models that
   * DECLARE reasoningControl get one, and only for levels present in their
   * levels map — a setting the provider cannot honor is never sent, so the
   * provider can't pretend and we can't lie about having applied it.
   */
  private reasoningParam(request: AIRequest): Record<string, string> | undefined {
    const control = this.config.reasoningControl;
    if (!control || !request.reasoningEffort || request.reasoningEffort === "auto") return undefined;
    const value = control.levels[request.reasoningEffort];
    return value !== undefined ? { [control.param]: value } : undefined;
  }

  async generate(request: AIRequest): Promise<AIResponse> {
    const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal: request.signal,
      body: JSON.stringify({
        model: this.wireModel(),
        messages: this.openaiMessages(request),
        temperature: request.temperature ?? this.config.defaultTemperature,
        top_p: request.topP ?? this.config.defaultTopP,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
        ...this.reasoningParam(request),
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
      reasoningContent: choice?.message?.reasoning_content || undefined,
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
    const body = (includeUsage: boolean) =>
      JSON.stringify({
        model: this.wireModel(),
        messages: this.openaiMessages(request),
        temperature: request.temperature ?? this.config.defaultTemperature,
        top_p: request.topP ?? this.config.defaultTopP,
        max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
        ...this.reasoningParam(request),
        tools: this.openaiTools(request),
        stream: true,
        // Most OpenAI-compatible servers only report token usage on a stream
        // when explicitly asked. Without it the run's cost is unknowable.
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
      });

    const post = (includeUsage: boolean) =>
      fetch(`${this.config.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: request.signal,
        body: body(includeUsage),
      });

    // Same progressive fallback the image path uses: older/stricter servers
    // reject stream_options outright, and losing usage beats losing the reply.
    let res = await post(true);
    if (res.status === 400) res = await post(false);

    if (!res.ok || !res.body) {
      throw new Error(`Model "${this.config.id}" stream failed: HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolAcc: { id: string; name: string; args: string }[] = [];
    let streamedText = "";
    let reasoningAcc = "";
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    const flushTools = function* () {
      for (const t of toolAcc) {
        if (!t.id && !t.name) continue;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(t.args || "{}");
        } catch {
          args = {};
        }
        yield { delta: "", toolCall: { id: t.id, name: t.name, arguments: args }, done: false } as AIChunk;
      }
    };

    const ingestMessage = function* (message: { content?: unknown; tool_calls?: any[] } | undefined) {
      if (!message) return;
      const full = typeof message.content === "string" ? message.content : "";
      if (full && !streamedText) {
        streamedText = full;
        yield { delta: full, done: false } as AIChunk;
      }
      if (message.tool_calls) {
        for (let i = 0; i < message.tool_calls.length; i++) {
          const tc = message.tool_calls[i];
          if (!toolAcc[i]) toolAcc[i] = { id: "", name: "", args: "" };
          if (tc.id) toolAcc[i].id = tc.id;
          if (tc.function?.name) toolAcc[i].name = tc.function.name;
          if (tc.function?.arguments && !toolAcc[i].args) toolAcc[i].args = String(tc.function.arguments);
        }
      }
    };

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
          yield* flushTools();
          yield { delta: "", reasoning: reasoningAcc || undefined, usage, done: true };
          return;
        }
        try {
          const json = JSON.parse(payload);
          // The usage-bearing chunk carries an empty `choices` array, so this
          // has to be read before the choices are dereferenced below.
          if (json.usage) {
            usage = {
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
            };
          }
          const delta = json.choices?.[0]?.delta;
          if (typeof delta?.reasoning_content === "string") reasoningAcc += delta.reasoning_content;
          const text = delta?.content ?? "";
          if (text) {
            streamedText += text;
            yield { delta: text, done: false };
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const i = tc.index ?? 0;
              if (!toolAcc[i]) toolAcc[i] = { id: "", name: "", args: "" };
              if (tc.id) toolAcc[i].id = tc.id;
              if (tc.function?.name) toolAcc[i].name += tc.function.name;
              if (tc.function?.arguments) toolAcc[i].args += tc.function.arguments;
            }
          }
          // Some servers (llama.cpp, a few vLLM builds) only put the assistant
          // sentence on choices[0].message, never as delta.content — without
          // this, tool-call narration never reaches the agent UI.
          yield* ingestMessage(json.choices?.[0]?.message);
        } catch {
          // Ignore malformed SSE fragments rather than crashing the stream.
        }
      }
    }
    yield* flushTools();
    yield { delta: "", reasoning: reasoningAcc || undefined, usage, done: true };
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
    return this.config.capabilities.tools;
  }

  supportsVision(): boolean {
    return this.config.capabilities.vision;
  }

  async generateImage(request: {
    prompt: string;
    size?: string;
    n?: number;
    quality?: string;
  }): Promise<{ b64?: string; url?: string; revisedPrompt?: string }[]> {
    const payload: Record<string, unknown> = {
      model: this.wireModel(),
      prompt: request.prompt,
      n: request.n ?? 1,
    };
    if (request.size) payload.size = request.size;

    const post = (body: Record<string, unknown>) =>
      fetch(`${this.config.endpoint}/v1/images/generations`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
      });

    // Progressive fallback: quality + b64 → b64 only → bare. Some
    // OpenAI-compatible servers reject params they don't implement.
    let res = request.quality
      ? await post({ ...payload, quality: request.quality, response_format: "b64_json" })
      : { ok: false } as Response;
    if (!res.ok) res = await post({ ...payload, response_format: "b64_json" });
    if (!res.ok) res = await post(payload);
    if (!res.ok) {
      throw new Error(`Image model "${this.config.id}" HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows.map((row: { b64_json?: string; url?: string; revised_prompt?: string }) => ({
      b64: row.b64_json,
      url: row.url,
      revisedPrompt: row.revised_prompt,
    }));
  }

  async embed(input: string): Promise<number[]> {
    const [vector] = await this.embedMany([input]);
    return vector ?? [];
  }

  async embedMany(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const res = await fetch(`${this.config.endpoint}/v1/embeddings`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.wireModel(),
        input: inputs.map((t) => t.slice(0, 24_000)),
      }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings "${this.config.id}" HTTP ${res.status}: ${await res.text()}`);
    }
    const data = await res.json();
    const rows = Array.isArray(data.data) ? [...data.data] : [];
    rows.sort((a: { index?: number }, b: { index?: number }) => (a.index ?? 0) - (b.index ?? 0));
    return rows.map((row: { embedding?: number[] }) => row.embedding ?? []);
  }
}
