// apps/desktop/src/renderer/contextUsage.ts
//
// Pure model for the Context Window + Usage popover. Every number the
// popover shows is either provider/backend-reported or an explicitly
// marked estimate from context assembly — nothing fabricated here.

export interface ContextBreakdown {
  systemPrompt?: number;
  messages?: number;
  toolDefinitions?: number;
  mcpTools?: number;
  projectContext?: number;
  memory?: number;
  skills?: number;
  meta?: number;
}

export interface ContextUsage {
  totalUsed: number;
  contextLimit: number;
  approximate?: boolean;
  categories?: ContextBreakdown;
  /** 0–1, only when the provider actually reports cached prompt tokens. */
  cacheHitRate?: number;
}

export type QuotaUnit = "tokens" | "requests" | "credits" | "minutes" | "usd";

export interface UsageQuota {
  id: string;
  label: string;
  used: number;
  limit?: number;
  remaining?: number | null;
  unit: QuotaUnit;
  resetAt?: number;
}

export type ContextSeverity = "normal" | "elevated" | "warning" | "critical";

/** Share of the model's context window currently in use (0–1). */
export function contextPercent(usage: ContextUsage | null | undefined): number | null {
  if (!usage || !usage.contextLimit || usage.contextLimit <= 0) return null;
  return Math.min(1, Math.max(0, usage.totalUsed / usage.contextLimit));
}

/** Semantic color state for the context bar. Calm until genuinely high. */
export function severityOf(percent: number | null): ContextSeverity {
  if (percent === null) return "normal";
  if (percent >= 0.95) return "critical";
  if (percent >= 0.85) return "warning";
  if (percent >= 0.70) return "elevated";
  return "normal";
}

/** The subtle high-context warning line; null below 85%. */
export function contextWarning(percent: number | null): string | null {
  if (percent === null) return null;
  if (percent >= 0.95) return "Context nearly full";
  if (percent >= 0.85) return "Context is getting full";
  return null;
}

/** True when switching to `newLimit` would not fit the current context. */
export function exceedsLimit(usage: ContextUsage | null | undefined, newLimit: number | null | undefined): boolean {
  if (!usage || usage.totalUsed <= 0) return false;
  if (!newLimit || newLimit <= 0) return false;
  return usage.totalUsed > newLimit;
}

export interface CategoryShare {
  key: keyof ContextBreakdown;
  label: string;
  tokens: number;
  /** Share of USED context (0–1), not of the model maximum. */
  share: number;
}

const CATEGORY_LABELS: Record<keyof ContextBreakdown, string> = {
  messages: "Messages",
  toolDefinitions: "System tools",
  systemPrompt: "System prompt",
  skills: "Skills",
  mcpTools: "MCP tools",
  projectContext: "Project context",
  memory: "Memory",
  meta: "Meta context",
};

/** Only categories ORVYN actually measured, sorted largest-first. */
export function categoryShares(usage: ContextUsage | null | undefined): CategoryShare[] {
  const cats = usage?.categories;
  if (!cats) return [];
  const measured = (Object.keys(CATEGORY_LABELS) as (keyof ContextBreakdown)[])
    .map((key) => ({ key, tokens: Number(cats[key] ?? 0) }))
    .filter((c) => c.tokens > 0);
  const totalMeasured = measured.reduce((n, c) => n + c.tokens, 0);
  if (totalMeasured <= 0) return [];
  return measured
    .map((c) => ({ key: c.key, label: CATEGORY_LABELS[c.key], tokens: c.tokens, share: c.tokens / totalMeasured }))
    .sort((a, b) => b.tokens - a.tokens);
}

/**
 * Normalizes provider cache spellings into a hit rate. Accepts either a
 * precomputed rate or raw cached/total tokens; returns null whenever the
 * provider did not report caching — a rate is never invented.
 */
export function cacheHitRate(
  source: { rate?: number | null; cachedTokens?: number | null; promptTokens?: number | null } | null | undefined,
): number | null {
  if (!source) return null;
  if (typeof source.rate === "number" && source.rate >= 0) return Math.min(1, source.rate);
  const cached = Number(source.cachedTokens ?? NaN);
  const prompt = Number(source.promptTokens ?? NaN);
  if (Number.isFinite(cached) && Number.isFinite(prompt) && cached >= 0 && prompt > 0) {
    return Math.min(1, cached / prompt);
  }
  return null;
}

/** Server /usage quota → popover row. Null when no limit is configured
 *  (the honest "tracking available, no quota" case). */
export function quotaFromServer(
  q: { limit?: number; used?: number; remaining?: number | null; resetsAt?: number } | null | undefined,
): UsageQuota | null {
  if (!q || !q.limit || q.limit <= 0) return null;
  return {
    id: "model-requests-month",
    label: "Model requests · monthly",
    used: Number(q.used ?? 0),
    limit: q.limit,
    remaining: typeof q.remaining === "number" ? q.remaining : Math.max(0, q.limit - Number(q.used ?? 0)),
    unit: "requests",
    ...(q.resetsAt ? { resetAt: q.resetsAt } : {}),
  };
}

/** "444.5K" / "1.0M" / "980" — compact token counts. */
export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** "44.5%" from 0.445. */
export function formatPercent(share: number | null | undefined, digits = 1): string {
  if (share === null || share === undefined || !Number.isFinite(share)) return "—";
  return `${(share * 100).toFixed(digits)}%`;
}
