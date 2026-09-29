// apps/backend/src/models/userModels.ts
//
// A customer's own models: validated (public https endpoint, OpenAI-
// compatible), ids namespaced under "my:", API keys sealed per tenant at
// rest and never returned to any client.

import type { ModelConfig } from "@orvyn/ai-core";
import { openSecret, sealSecret } from "../secrets/vault";
import { assertPublicModelEndpoint, customerCatalogEnabled, USER_MODEL_PREFIX } from "./customerCatalog";

type Stored = ModelConfig & { apiKeySealed?: string };

export function sealModelConfig(config: ModelConfig, tenantId: string): Stored {
  const { apiKey, ...rest } = config;
  return apiKey ? { ...rest, apiKeySealed: sealSecret(apiKey, tenantId, `model:${config.id}`) } : rest;
}

export function openModelConfig(saved: Stored, tenantId: string): ModelConfig {
  const { apiKeySealed, ...rest } = saved;
  if (!apiKeySealed) return rest;
  const apiKey = openSecret(apiKeySealed, tenantId, `model:${saved.id}`);
  if (apiKey === null) throw new Error("its API key could not be unsealed");
  return { ...rest, apiKey };
}

/** What any client may see of a customer's model: never the key. */
export function publicUserModel(config: ModelConfig) {
  const { apiKey, ...rest } = config;
  return { ...rest, kind: "user" as const, readOnly: false, hasApiKey: Boolean(apiKey) };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

/**
 * Builds a customer model from form input. On ORVYN Cloud the endpoint must
 * be public https and the wire format OpenAI-compatible.
 */
export async function buildUserModel(input: Record<string, any>, opts: { existing?: ModelConfig; id?: string } = {}): Promise<ModelConfig> {
  const name = String(input.name ?? opts.existing?.name ?? "").trim().slice(0, 80);
  const apiModelId = String(input.apiModelId ?? input.model ?? opts.existing?.apiModelId ?? "").trim().slice(0, 160);
  const endpoint = String(input.endpoint ?? opts.existing?.endpoint ?? "").trim();
  if (!name) throw new Error("Give your model a name.");
  if (!apiModelId) throw new Error("Enter the model name your provider expects (e.g. gpt-4o or llama-3.3-70b).");
  const cloud = customerCatalogEnabled();
  const provider = cloud ? "openai-compatible" : String(input.provider ?? opts.existing?.provider ?? "openai-compatible");
  // Test harnesses only (never set in production): allow a local scripted model.
  const testLocal = process.env.ORVYN_TEST_ALLOW_PRIVATE_MODEL_ENDPOINTS === "1" && process.env.NODE_ENV !== "production";
  if (cloud && !testLocal) await assertPublicModelEndpoint(endpoint);
  if (cloud && testLocal && !/^https?:\/\//.test(endpoint)) throw new Error("Enter the model's API address.");
  const id = opts.id ?? opts.existing?.id ?? `${USER_MODEL_PREFIX}${slug(name) || "model"}`;
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : opts.existing?.apiKey;
  const caps = input.capabilities ?? opts.existing?.capabilities ?? {};
  const num = (v: unknown, d: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d;
  };
  return {
    id,
    name,
    provider,
    // The adapter adds /v1/chat/completions: accept the base URL however it was pasted.
    endpoint: endpoint.replace(/\/+$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, ""),
    apiModelId,
    ...(apiKey ? { apiKey } : {}),
    contextWindow: num(input.contextWindow ?? opts.existing?.contextWindow, 128_000, 2_048, 2_000_000),
    maxOutputTokens: num(input.maxOutputTokens ?? opts.existing?.maxOutputTokens, 8_192, 256, 200_000),
    defaultTemperature: 0.3,
    defaultTopP: 1,
    streaming: true,
    capabilities: {
      chat: true,
      code: caps.code !== false,
      agent: caps.tools !== false,
      tools: caps.tools !== false,
      vision: caps.vision === true,
      embeddings: false,
      completion: true,
      image: false,
    },
  };
}
