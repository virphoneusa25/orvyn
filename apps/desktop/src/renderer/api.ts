// apps/desktop/src/renderer/api.ts
import { apiUrl, authHeaders, noteProtectedStatus } from "./connection";

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
  provider: "ollama" | "vllm" | "llamacpp" | "openai-compatible" | "custom-http" | "mock";
  endpoint: string;
  apiKey?: string;
  apiModelId?: string;
  contextWindow: number;
  maxOutputTokens: number;
  defaultTemperature: number;
  defaultTopP: number;
  streaming: boolean;
  capabilities: ModelCapabilities;
}

export interface ModelHealthResult {
  id: string;
  status: "online" | "connecting" | "offline" | "error";
  latencyMs?: number;
  error?: string;
}

export interface ModelTestResult {
  ok: boolean;
  latencyMs: number;
  snippet?: string;
  finishReason?: string;
  error?: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

function req(path: string, options: RequestInit = {}): Promise<Response> {
  const url = apiUrl(path);
  return fetch(url, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...authHeaders(), ...options.headers },
  }).then((res) => {
    noteProtectedStatus(res.status, url);
    return res;
  });
}

export const api = {
  listModels: () => req("/models").then((r) => json<{ models: ModelConfig[] }>(r)),

  addModel: (config: ModelConfig) =>
    req("/models", { method: "POST", body: JSON.stringify(config) }).then((r) => json<{ model: ModelConfig }>(r)),

  updateModel: (id: string, config: ModelConfig) =>
    req(`/models/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(config) }).then((r) =>
      json<{ model: ModelConfig }>(r)
    ),

  deleteModel: (id: string) => req(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),

  healthAll: () => req("/models/health").then((r) => json<{ results: ModelHealthResult[] }>(r)),

  testModel: (id: string) => req(`/models/${encodeURIComponent(id)}/test`, { method: "POST" }).then((r) => json<ModelTestResult>(r)),

  getRouting: () => req("/routing").then((r) => json<{ overrides: Record<string, string> }>(r)),

  setRouting: (task: string, modelId: string) =>
    req("/routing", { method: "POST", body: JSON.stringify({ task, modelId }) }).then((r) =>
      json<{ overrides: Record<string, string> }>(r)
    ),
};

