// packages/ai-core/src/types.ts
// Provider-agnostic contracts. Nothing in here may reference a specific
// vendor (OpenAI, Anthropic, etc). Adapters translate TO these shapes.

export type Role = "system" | "user" | "assistant" | "tool";

/** A file or image the user attached as context for a request. */
export interface Attachment {
  kind: "file" | "image";
  name: string;
  /** Text content, for kind === "file". */
  content?: string;
  /** Base64 payload (no data: prefix), for kind === "image". */
  b64?: string;
  mediaType?: string;
}

export interface AIMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
  /**
   * Chain-of-thought from thinking models (DeepSeek `reasoning_content`).
   * Some APIs REQUIRE it passed back on assistant turns in multi-round tool
   * flows — dropping it causes HTTP 400 on the next request.
   */
  reasoningContent?: string;
  /** Vision / screenshot attachments as data URLs or https URLs. */
  images?: { url: string }[];
  /** Attached files/images. Vision models get image_url parts; text is folded in. */
  attachments?: Attachment[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** Provider-neutral reasoning effort. "auto" defers entirely to the
 *  provider's default — it is never translated to a concrete level. */
export type ReasoningEffort = "auto" | "fast" | "standard" | "deep" | "max";

export interface AIRequest {
  messages: AIMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  /** Requested reasoning effort; only honored when the model declares
   *  reasoningControl and the level exists in its levels map. */
  reasoningEffort?: ReasoningEffort;
  stream?: boolean;
  /**
   * Aborts the in-flight HTTP request. This is what makes a "Stop" button
   * actually stop work rather than just hiding it: without it, a cancelled
   * run keeps streaming tokens the user is still billed for.
   */
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  /** Thinking-model chain-of-thought; callers must echo it back (see AIMessage). */
  reasoningContent?: string;
  finishReason: "stop" | "length" | "tool_call" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AIChunk {
  delta: string;
  toolCall?: ToolCall;
  /** Accumulated thinking-model reasoning, set once on the final chunk. */
  reasoning?: string;
  /**
   * Token accounting, when the server reports it. Set on the final chunk only.
   * Streaming APIs omit usage unless asked, so treat absence as "unknown"
   * rather than zero.
   */
  usage?: TokenUsage;
  done: boolean;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ModelCapabilities {
  chat: boolean;
  code: boolean;
  agent: boolean;
  tools: boolean;
  vision: boolean;
  embeddings: boolean;
  completion: boolean;
  image: boolean;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string; // "ollama" | "vllm" | "llamacpp" | "openai-compatible" | "custom-http"
  endpoint: string;
  /** Wire-format model name when it differs from `id` (e.g. `ci:gpt-5.6-luna` → `gpt-5.6-luna`). */
  apiModelId?: string;
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  defaultTemperature: number;
  defaultTopP: number;
  streaming: boolean;
  capabilities: ModelCapabilities;
  /**
   * Truthful reasoning-effort support: when absent, the model does NOT
   * accept a reasoning control and any requested level is ignored (never
   * silently sent). `param` is the wire field; `levels` maps our neutral
   * levels to this provider's values — only levels present here are
   * offered/allowed (e.g. a model without "max" support omits it).
   */
  reasoningControl?: {
    param: string;
    levels: Partial<Record<Exclude<ReasoningEffort, "auto">, string>>;
  };
}

export type ModelStatus = "online" | "connecting" | "offline" | "error";

// Every model adapter (Ollama, vLLM, llama.cpp, custom HTTP, etc.)
// implements this. The IDE and orchestrator only ever talk to this
// interface — never to a vendor SDK directly.
export interface AIModelProvider {
  readonly config: ModelConfig;
  generate(request: AIRequest): Promise<AIResponse>;
  stream(request: AIRequest): AsyncIterable<AIChunk>;
  embed?(input: string): Promise<number[]>;
  embedMany?(inputs: string[]): Promise<number[][]>;
  generateImage?(request: {
    prompt: string;
    size?: string;
    n?: number;
    /** "high" | "medium" | "low"; adapters fall back if the server rejects it. */
    quality?: string;
  }): Promise<{ b64?: string; url?: string; revisedPrompt?: string }[]>;
  healthCheck(): Promise<{ status: ModelStatus; latencyMs?: number; error?: string }>;
  supportsTools(): boolean;
  supportsVision(): boolean;
}
