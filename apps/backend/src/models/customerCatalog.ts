// apps/backend/src/models/customerCatalog.ts
//
// What a customer sees of ORVYN's models. ORVYN Cloud runs many models from
// several vendors; customers choose between six ORVYN models by what they do
// (Auto, Fast, Reasoning, Code, Research, Vision). Vendor names, registry
// ids and endpoints stay server-side, and ORVYN's own models cannot be
// edited, deleted or re-pointed by a customer.
//
// Customers may add their OWN models (their key, their endpoint — any
// OpenAI-compatible API). Those are theirs to edit, can be picked per
// conversation, and can be set as the default that replaces ORVYN's routing.
// Calls to a customer's own model use their provider account, not ORVYN
// credits.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { LADDERS, stepFrom, TIERS, type Tier } from "./routingPolicy";

export type CustomerModelId = "auto" | "fast" | "reasoning" | "code" | "research" | "vision";

export interface CustomerModel {
  id: CustomerModelId;
  name: string;
  description: string;
}

export const CUSTOMER_MODELS: CustomerModel[] = [
  { id: "auto", name: "Auto", description: "Picks the best model for each task" },
  { id: "fast", name: "Fast", description: "Quick answers and small edits" },
  { id: "reasoning", name: "Reasoning", description: "Planning, analysis and hard problems" },
  { id: "code", name: "Code", description: "Building, fixing and deploying software" },
  { id: "research", name: "Research", description: "In-depth research and long answers" },
  { id: "vision", name: "Vision", description: "Understands images and screenshots" },
];

/** Tiers each ORVYN model runs on (first registered wins). */
export const CUSTOMER_TIERS: Record<Exclude<CustomerModelId, "vision">, Tier[]> = {
  auto: LADDERS.auto,
  fast: ["utility", "auto", "agent"],
  reasoning: ["deep"],
  code: LADDERS.code,
  research: ["research", "deep"],
};

/** Prefix for customer-owned models, so they can never collide with ORVYN's. */
export const USER_MODEL_PREFIX = "my:";

export function isCustomerModelId(id: string | undefined | null): id is CustomerModelId {
  return Boolean(id) && CUSTOMER_MODELS.some((m) => m.id === id);
}

export function isUserModelId(id: string | undefined | null): boolean {
  return Boolean(id) && String(id).startsWith(USER_MODEL_PREFIX);
}

/** ORVYN Cloud (or forced on): customers see the catalog, not the registry. */
export function customerCatalogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORVYN_CUSTOMER_CATALOG === "false") return false;
  return env.ORVYN_CUSTOMER_CATALOG === "true" || env.ORVYN_CLOUD_MODE === "true";
}

interface RegistryView { id: string; vision: boolean; chat: boolean; mock: boolean }

/** The platform registry id that serves an ORVYN model right now (server-side only). */
export function resolveCustomerModel(id: CustomerModelId, registry: RegistryView[]): string | null {
  const platform = registry.filter((r) => !isUserModelId(r.id) && !r.mock);
  if (id === "vision") {
    const preferred = stepFrom(["vision", "server", "auto"], 0, platform.filter((r) => r.vision).map((r) => r.id));
    return preferred?.registryId ?? platform.find((r) => r.vision && r.chat)?.id ?? null;
  }
  return stepFrom(CUSTOMER_TIERS[id], 0, platform.map((r) => r.id))?.registryId ?? null;
}

/** The catalog a customer sees, with availability. */
export function customerCatalog(registry: RegistryView[]) {
  return CUSTOMER_MODELS.map((m) => ({
    id: m.id,
    name: m.name,
    description: m.description,
    kind: "orvyn" as const,
    readOnly: true,
    available: m.id === "auto" ? registry.some((r) => !isUserModelId(r.id) && !r.mock) : Boolean(resolveCustomerModel(m.id, registry)),
    capabilities: {
      chat: true, code: true, agent: true, tools: true, vision: m.id === "vision" || m.id === "auto",
      embeddings: false, completion: true, image: false,
    },
  }));
}

/** The ORVYN name a platform registry id is shown under (never the vendor). */
export function customerNameFor(registryId: string): string {
  if (isUserModelId(registryId)) return registryId.slice(USER_MODEL_PREFIX.length);
  const tierOf = (Object.values(TIERS) as { tier: Tier; candidates: string[] }[]).find((t) => t.candidates.includes(registryId))?.tier;
  switch (tierOf) {
    case "utility": case "code-helper": return "ORVYN Fast";
    case "auto": case "agent": return "ORVYN Auto";
    case "code": case "heavy": return "ORVYN Code";
    case "server": return "ORVYN Auto";
    case "research": return "ORVYN Research";
    case "vision": return "ORVYN Vision";
    case "premium": case "deep": case "ultra": return "ORVYN Reasoning";
    default: return "ORVYN";
  }
}

const VENDOR_WORDS = /\b(nebius|fireworks(?:\.ai)?|cheaper ?inference|cheaperinference|openrouter|mistral|gemini|deepseek|kimi|moonshot(?:ai)?|qwen|glm|zai-org|minimax|nemotron|claude|anthropic|openai|gpt-[\w.-]+|llama|flux)\b/gi;
const VENDOR_URL = /https?:\/\/[^\s"']*(nebius|fireworks|cheaperinference|openrouter|mistral|googleapis|generativelanguage)[^\s"']*/gi;
const VENDOR_KEY = /^(nebius|fireworks|fw|ci|cheaperinference|cheaper-inference|openrouter|mistral|gemini|google|openai|openai-compatible|anthropic|deepseek)$/i;

function merge(a: unknown, b: unknown): unknown {
  if (typeof a === "number" && typeof b === "number") return a + b;
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
    for (const [k, v] of Object.entries(b as Record<string, unknown>)) out[k] = k in out ? merge(out[k], v) : v;
    return out;
  }
  return b;
}

/** Fields that name a model: shown as the ORVYN name. */
const MODEL_KEYS = new Set(["modelId", "selectedModel", "model", "actualModelId", "requestedModelId", "pinnedModelId", "fallbackModel", "fallback", "registryId", "from", "to", "models"]);
/** Diagnostic text (errors, failover reasons): vendor names and URLs removed. */
const DIAGNOSTIC_KEYS = new Set(["error", "detail", "reason", "failoverReason", "fallbackReason", "failure", "lastError", "toolFallbackReason", "diagnostic"]);
/** Never touched: what the user and the assistant wrote. */
const CONTENT_KEYS = new Set(["content", "delta", "text", "instruction", "prompt", "answer", "summary", "markdown", "body", "title", "goal"]);

/**
 * Removes vendor identity from anything bound for a customer (run events,
 * usage, errors): platform registry ids become ORVYN names, vendor names
 * and endpoints disappear from diagnostics. Conversation content is left
 * exactly as written. Customer-owned model ids are kept.
 */
export function redactForCustomer<T>(value: T, platformIds: ReadonlySet<string>): T {
  const ids = [...platformIds].filter((id) => !isUserModelId(id) && id.length > 3).sort((a, b) => b.length - a.length);
  const swapIds = (s: string): string => {
    let out = s;
    for (const id of ids) if (out.includes(id)) out = out.split(id).join(customerNameFor(id));
    return out;
  };
  const diagnostic = (s: string) => swapIds(s).replace(VENDOR_URL, "the model service").replace(VENDOR_WORDS, "ORVYN");
  const walk = (v: unknown, key: string, depth: number): unknown => {
    if (depth > 14) return v;
    if (typeof v === "string") {
      if (isUserModelId(v) || CONTENT_KEYS.has(key)) return v;
      if (MODEL_KEYS.has(key)) return platformIds.has(v) || /^[a-z]+:/.test(v) ? customerNameFor(v) : diagnostic(v);
      if (DIAGNOSTIC_KEYS.has(key)) return diagnostic(v);
      return swapIds(v);
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, key, depth + 1));
    if (v && typeof v === "object") {
      // Serving telemetry is an explicit, bounded public contract; credentials
      // and adapter configuration remain redacted everywhere, including here.
      if (key === "routing") {
        const r = v as Record<string, unknown>;
        return { provider: String(r.provider ?? "").slice(0, 80), modelId: String(r.modelId ?? "").slice(0, 240), reason: String(r.reason ?? "").slice(0, 600) };
      }
      // A customer's own model is shown to them as they entered it (never its key).
      if ((v as { kind?: unknown }).kind === "user" && isUserModelId((v as { id?: string }).id)) {
        const { apiKey: _k, ...own } = v as Record<string, unknown>;
        return own;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "endpoint" || k === "apiKey" || k === "apiModelId") continue;
        if (k === "provider" && typeof x === "string") { out[k] = isUserModelId(x) ? x : "ORVYN"; continue; }
        const value = walk(x, CONTENT_KEYS.has(key) ? key : k, depth + 1);
        // Maps keyed by model or vendor (usage by model/provider) are re-keyed and merged.
        const name = CONTENT_KEYS.has(key) ? k : platformIds.has(k) && !isUserModelId(k) ? customerNameFor(k) : VENDOR_KEY.test(k) ? "ORVYN" : k;
        out[name] = name in out && name !== k ? merge(out[name], value) : value;
      }
      return out;
    }
    return v;
  };
  return walk(value, "", 0) as T;
}

// ---------- customer-owned model endpoints (no reaching into ORVYN's network) ----------

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
    const mapped = v.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? privateAddress(mapped[1]!) : false;
  }
  const [a, b] = ip.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * A customer's model endpoint must be a public HTTPS URL: never ORVYN's own
 * services, the host's metadata endpoint, or a private network address.
 */
export async function assertPublicModelEndpoint(raw: string, resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address)): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("Enter the model's API address, e.g. https://api.example.com/v1"); }
  if (url.protocol !== "https:") throw new Error("Your model's address must use https://");
  if (url.username || url.password) throw new Error("Put the API key in the key field, not in the address.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal|metadata(\.google\.internal)?)$/i.test(host)) throw new Error("That address isn't reachable from ORVYN Cloud. Use a public https:// endpoint.");
  const addresses = isIP(host) ? [host] : await resolve(host).catch(() => { throw new Error(`Couldn't find ${host}. Check the address.`); });
  if (!addresses.length || addresses.some(privateAddress)) throw new Error("That address isn't reachable from ORVYN Cloud. Use a public https:// endpoint.");
  return url;
}
