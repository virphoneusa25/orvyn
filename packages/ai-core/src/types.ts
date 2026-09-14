// packages/ai-core/src/types.ts
// Provider-agnostic contracts. Nothing in here may reference a specific
// vendor (OpenAI, Anthropic, etc). Adapters translate TO these shapes.

export type Role = "system" | "user" | "assistant" | "tool";

export interface AIMessage {
  role: Role;
  content: string;
  toolCallId?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface AIRequest {
  messages: AIMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  topP?: number;
  maxOutputTokens?: number;
  stream?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AIResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: "stop" | "length" | "tool_call" | "error";
  usage?: { promptTokens: number; completionTokens: number };
}

export interface AIChunk {
  delta: string;
  toolCall?: ToolCall;
  done: boolean;
}

export interface ModelCapabilities {
  chat: boolean;
  code: boolean;
  agent: boolean;
  tools: boolean;
  vision: boolean;
  embeddings: boolean;
  completion: boolean;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: string; // "ollama" | "vllm" | "llamacpp" | "openai-compatible" | "custom-http"
  endpoint: string;
  apiKey?: string;
  contextWindow: number;
  maxOutputTokens: number;
  defaultTemperature: number;
  defaultTopP: number;
  streaming: boolean;
  capabilities: ModelCapabilities;
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
  healthCheck(): Promise<{ status: ModelStatus; latencyMs?: number; error?: string }>;
  supportsTools(): boolean;
  supportsVision(): boolean;
}
