// apps/backend/src/models/routingPolicy.ts
//
// ORVYN's model routing policy: cheap models try first, stronger ones only
// when the work needs them, premium only as escalation. Each run gets a
// profile (Code, Server, Auto, Deep) with its own ladder of tiers; a run
// starts on the first tier that is registered and climbs one step when the
// work stalls (repeated tool failures, a verifier FAIL, a completion gate
// retry). Every tier has a credit weight, so a run's cost is metered and
// capped per profile.
//
// Tiers name a job, not a vendor: each lists candidate models in order of
// preference, and the first one that is registered (its provider key is set)
// serves the tier. With no new provider keys, ORVYN keeps today's models.

import { isModelUnavailable } from "./modelAvailability";

export type RouteProfile = "code" | "server" | "auto" | "deep";

export type Tier =
  | "utility"       // greetings, titles, summaries, memory extraction, log digests
  | "code-helper"   // small edits, boilerplate, syntax fixes
  | "auto"          // everyday agent work
  | "agent"         // tool-heavy fallback for everyday work
  | "code"          // normal coding / builds (long-horizon agentic coding)
  | "advanced"      // long-horizon agents, server diagnosis, strong reasoning
  | "heavy"         // hard engineering and repairs
  | "deep"          // premium recovery
  | "ultra";        // extreme escalation only

export interface TierDef {
  tier: Tier;
  /** Credits per 1,000 tokens (input + output) on this tier. */
  weight: number;
  /** Registry ids in order of preference; the first registered one serves. */
  candidates: string[];
  label: string;
}

export const TIERS: Record<Tier, TierDef> = {
  utility: { tier: "utility", weight: 1, label: "Utility", candidates: ["mistral:mistral-small-4-0-26-03", "ci:gpt-5.6-luna", "fw:accounts/fireworks/models/glm-5p3-flash"] },
  "code-helper": { tier: "code-helper", weight: 1, label: "Code helper", candidates: ["mistral:codestral-25-08"] },
  auto: { tier: "auto", weight: 1, label: "Auto", candidates: ["openrouter:deepseek/deepseek-v3.2", "fw:accounts/fireworks/models/deepseek-v4p1-flash"] },
  agent: { tier: "agent", weight: 2, label: "Agent", candidates: ["openrouter:minimax/minimax-m2.5", "fw:accounts/fireworks/models/deepseek-v4p1-flash"] },
  code: { tier: "code", weight: 4, label: "Code", candidates: ["fw:accounts/fireworks/models/kimi-k2p7-code"] },
  advanced: { tier: "advanced", weight: 4, label: "Advanced", candidates: ["gemini:gemini-3.8-flash"] },
  heavy: { tier: "heavy", weight: 6, label: "Heavy engineering", candidates: ["fw:accounts/fireworks/models/glm-5p3", "mistral:zai-glm-5-3"] },
  deep: { tier: "deep", weight: 12, label: "Deep", candidates: ["ci:claude-sonnet-5"] },
  ultra: { tier: "ultra", weight: 25, label: "Ultra", candidates: ["ci:gpt-5.6-sol"] },
};

/** The climb for each profile. Ultra is appended only when allowed. */
export const LADDERS: Record<RouteProfile, Tier[]> = {
  code: ["code", "heavy", "deep"],
  server: ["advanced", "heavy", "deep"],
  auto: ["auto", "agent", "heavy", "deep"],
  deep: ["advanced", "deep"],
};

/** Credits a run of each profile may spend before it stops (0 = no cap). */
export const DEFAULT_RUN_CREDITS: Record<RouteProfile, number> = {
  auto: 1500,
  code: 4000,
  server: 4000,
  deep: 1500,
};

export function runCreditBudget(profile: RouteProfile, env: NodeJS.ProcessEnv = process.env): number {
  const specific = Number(env[`ORVYN_RUN_CREDITS_${profile.toUpperCase()}`]);
  if (Number.isFinite(specific) && specific >= 0 && env[`ORVYN_RUN_CREDITS_${profile.toUpperCase()}`] !== undefined) return specific;
  const all = Number(env.ORVYN_RUN_CREDITS);
  if (Number.isFinite(all) && all >= 0 && env.ORVYN_RUN_CREDITS !== undefined) return all;
  return DEFAULT_RUN_CREDITS[profile];
}

export function ultraAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVYN_ALLOW_ULTRA_ESCALATION === "1" || env.ORVYN_ALLOW_ULTRA_ESCALATION === "true";
}

const SERVER = /\b(ssh|server|vps|nginx|caddy|apache|systemd|systemctl|journalctl|docker(?:-compose)?|compose|kubernetes|k8s|firewall|ufw|iptables|dns|ssl|tls|certbot|letsencrypt|postgres(?:ql)?|redis|mysql|mariadb|deploy(?:ment)?|502|503|504|uptime|disk space|memory usage|cron|kamailio|freeswitch|asterisk|sip)\b/i;
const CODE = /\b(code|coding|refactor|implement|function|component|bug|debug|fix|test|tests|build|compile|typescript|javascript|python|react|next\.?js|vite|api|endpoint|app|website|landing page|repo|repository|script)\b|\.(?:[jt]sx?|py|go|rs|java|cs|php|rb|css|html)\b/i;
const SMALL_EDIT = /\b(typo|rename|small (?:change|edit|fix)|one[- ]line|change (?:the )?(?:text|title|label|color|colour|wording|copy)|update (?:the )?(?:text|title|label|comment|version)|add a comment|fix (?:the )?indentation|format (?:this|the) file|boilerplate)\b/i;

/** Which profile a run belongs to. The composer mode wins; otherwise the task decides. */
export function profileFor(input: { composerMode?: string; category?: string; instruction: string; deep?: boolean }): RouteProfile {
  const mode = (input.composerMode ?? "").toLowerCase();
  if (mode === "server" || mode === "deploy") return "server";
  if (mode === "code") return "code";
  if (input.category === "server" || input.category === "deploy") return "server";
  if (SERVER.test(input.instruction) && !/\.(?:[jt]sx?|css|html)\b/i.test(input.instruction)) return "server";
  if (input.deep) return "deep";
  if (input.category === "code" || input.category === "frontend" || CODE.test(input.instruction)) return "code";
  return "auto";
}

/** A small, contained edit: start on the cheap code helper (it climbs to Code if it struggles). */
export function isSmallEdit(instruction: string): boolean {
  const t = String(instruction ?? "").trim();
  return t.length <= 200 && SMALL_EDIT.test(t);
}

export interface RouteStep {
  profile: RouteProfile;
  tiers: Tier[];
  /** Index into `tiers`. */
  step: number;
  tier: Tier;
  registryId: string | null;
  weight: number;
  reason: string;
}

export interface ModelHealthLike { registryId: string; failureRate: number }

function firstRegistered(tier: Tier, available: Set<string>, health: ModelHealthLike[]): string | null {
  for (const id of TIERS[tier].candidates) {
    if (!available.has(id) || isModelUnavailable(id)) continue;
    const h = health.find((x) => x.registryId === id);
    if (h && h.failureRate >= 0.5) continue;
    return id;
  }
  return null;
}

/** The ladder for a run: small edits start on the code helper; ultra only when allowed. */
export function ladderFor(profile: RouteProfile, opts: { smallEdit?: boolean; allowUltra?: boolean } = {}): Tier[] {
  const tiers = [...LADDERS[profile]];
  if (profile === "code" && opts.smallEdit) tiers.unshift("code-helper");
  if (opts.allowUltra) tiers.push("ultra");
  return tiers;
}

/** The tier at `from` or the next one above it that has a registered model. */
export function stepFrom(tiers: Tier[], from: number, available: string[], health: ModelHealthLike[] = []): { step: number; tier: Tier; registryId: string } | null {
  const ids = new Set(available);
  for (let i = Math.max(0, from); i < tiers.length; i++) {
    const id = firstRegistered(tiers[i]!, ids, health);
    if (id) return { step: i, tier: tiers[i]!, registryId: id };
  }
  return null;
}

export function startRoute(input: {
  profile: RouteProfile;
  instruction: string;
  availableIds: string[];
  health?: ModelHealthLike[];
  allowUltra?: boolean;
}): RouteStep {
  const tiers = ladderFor(input.profile, { smallEdit: isSmallEdit(input.instruction), allowUltra: input.allowUltra ?? ultraAllowed() });
  const hit = stepFrom(tiers, 0, input.availableIds, input.health);
  const why: Record<RouteProfile, string> = {
    code: "Code agent: long-horizon coding model first; heavier models only if it struggles.",
    server: "Server agent: long-context agent model for logs and configs; heavier models only if it struggles.",
    auto: "Auto: the cheapest capable agent model first.",
    deep: "Deep question: a strong reasoning model; premium only as escalation.",
  };
  return {
    profile: input.profile,
    tiers,
    step: hit?.step ?? 0,
    tier: hit?.tier ?? tiers[0]!,
    registryId: hit?.registryId ?? null,
    weight: TIERS[hit?.tier ?? tiers[0]!].weight,
    reason: hit ? why[input.profile] : "No model for this profile is registered.",
  };
}

/** One step up the ladder (skipping tiers with no registered model). Null when already at the top. */
export function escalate(route: RouteStep, availableIds: string[], health: ModelHealthLike[] = [], reason = "The work stalled."): RouteStep | null {
  const hit = stepFrom(route.tiers, route.step + 1, availableIds, health);
  if (!hit || hit.registryId === route.registryId) {
    // Same model on the next tier (e.g. a fallback shared by two tiers): keep climbing.
    if (hit && hit.step + 1 < route.tiers.length) return escalate({ ...route, step: hit.step }, availableIds, health, reason);
    return null;
  }
  return { ...route, step: hit.step, tier: hit.tier, registryId: hit.registryId, weight: TIERS[hit.tier].weight, reason };
}

/** The weight of whatever model served a call (unknown models count as Auto). */
export function weightFor(registryId: string): number {
  for (const def of Object.values(TIERS)) if (def.candidates.includes(registryId)) return def.weight;
  return TIERS.auto.weight;
}

/** Credits for one model call. */
export function creditsFor(registryId: string, usage: { promptTokens?: number; completionTokens?: number }): number {
  const tokens = Number(usage.promptTokens ?? 0) + Number(usage.completionTokens ?? 0);
  return (tokens / 1000) * weightFor(registryId);
}
