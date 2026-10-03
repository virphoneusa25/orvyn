import type { AIModelProvider, ModelConfig } from "./types";

/** Requirements belong to the request, rather than to a product or model lane. */
export interface RoutingRequirements {
  capability: keyof ModelConfig["capabilities"];
  tools?: boolean;
  vision?: boolean;
  streaming?: boolean;
  contextTokens?: number;
}

export type RouteFamily = "flash" | "advanced" | "code" | "premium";
export function routeFamily(id: string): RouteFamily | undefined {
  if (/glm[-/]?5[.p]3[-/]?flash/i.test(id)) return "flash";
  if (/glm[-/]?5[.p]3/i.test(id)) return "advanced";
  if (/kimi[-/]?k2[.p]7[-/]?code/i.test(id)) return "code";
  if (/kimi[-/]?k3/i.test(id)) return "premium";
  return undefined;
}

export function incompatibility(config: ModelConfig, needs: RoutingRequirements): string | undefined {
  if (config.routingVerification && config.routingVerification.status !== "verified") return config.routingVerification.reason;
  if (config.providerName === "huggingface" && (!config.rate || config.rate.expiresAt <= Date.now())) return "verified provider price expired or unavailable";
  if (!config.capabilities[needs.capability]) return `missing ${needs.capability} capability`;
  if (needs.tools && !config.capabilities.tools) return "tool calling unsupported";
  if (needs.vision && !config.capabilities.vision) return "vision unsupported";
  if (needs.streaming && !config.streaming) return "streaming unsupported";
  if (needs.contextTokens && config.contextWindow < needs.contextTokens) return "context window too small";
  return undefined;
}

/** Shared by the Cloud backend and the backend bundled with Desktop. */
export function preferHuggingFace(providers: AIModelProvider[], needs: RoutingRequirements, enabled: boolean,
  unavailable: (id: string) => boolean = () => false, family?: RouteFamily): { provider?: AIModelProvider; reason: string } {
  if (!enabled) return { reason: "Hugging Face Auto routing disabled" };
  if (!family) return { reason: "Existing quality-tested route retained; no equivalent price comparison" };
  const hf = providers.filter((p) => p.config.providerName === "huggingface" && routeFamily(p.config.id) === family);
  if (!hf.length) return { reason: "Hugging Face credentials or configured models unavailable" };
  const reasons: string[] = [];
  const compatible: AIModelProvider[] = [];
  let incompletePrices = false;
  for (const p of providers.filter((p) => routeFamily(p.config.id) === family && (p.config.providerName === "huggingface" || p.config.id.startsWith("nebius:") || p.config.providerName === "fireworks"))) {
    const reason = unavailable(p.config.id) ? "provider/model unavailable" : incompatibility(p.config, needs);
    const rate = p.config.rate;
    if (reason || !rate || rate.expiresAt <= Date.now()) {
      reasons.push(`${p.config.id}: ${reason ?? "exact current rate unavailable"}`);
      if (!reason && p.config.providerName !== "huggingface") incompletePrices = true;
    }
    else compatible.push(p);
  }
  // Compare like-for-like models. Input/output both must be no more expensive;
  // crossing price curves cannot be ranked without a request-specific forecast.
  // Stable Nebius preference on ties preserves the established Flash route.
  const tieRank = (p: AIModelProvider) => p.config.id.startsWith("nebius:") ? 0 : p.config.providerName === "fireworks" ? 1 : 2;
  compatible.sort((a, b) => tieRank(a) - tieRank(b));
  if (incompletePrices) return { reason: `Price comparison incomplete; existing route retained: ${reasons.join("; ")}` };
  const best = compatible.find((a) => compatible.every((b) => a.config.rate!.input <= b.config.rate!.input + 1e-9 && a.config.rate!.output <= b.config.rate!.output + 1e-9));
  if (best) return { provider: best, reason: `Equivalent ${family} route: current input/output rates; ties retain established provider${reasons.length ? `; skipped ${reasons.join("; ")}` : ""}` };
  return { reason: `Hugging Face fallback: ${reasons.join("; ")}` };
}
