// Marketplace UI request policy. Renderer never talks to Official/Glama/Smithery
// except through ORVYN APIs or the allowlisted desktop Official IPC fallback.

import type { MarketServer } from "./mcpMarketplaceModel.ts";

export const MARKETPLACE_DEBOUNCE_MS = 350;

export type ProviderDotStatus =
  | "online"
  | "slow"
  | "auth-required"
  | "rate-limited"
  | "offline"
  | "error"
  | "disabled"
  | "needs-key";

export interface ProviderStatusView {
  id: string;
  name: string;
  status: ProviderDotStatus;
  detail?: string;
  latencyMs?: number;
  resultCount?: number;
}

export type MarketplaceEmptyKind = "results" | "true-empty" | "provider-failure" | "offline" | "auth-required";

export interface MarketplaceViewState {
  items: MarketServer[];
  providers: Record<string, ProviderStatusView>;
  degraded: boolean;
  fromCache: boolean;
  stale?: boolean;
  emptyKind: MarketplaceEmptyKind;
  banner?: string;
  error?: string;
}

const REMOTE_IDS = new Set(["official", "glama", "smithery", "private"]);

export function emptyKindFor(input: {
  resultCount: number;
  fromCache?: boolean;
  providers: Record<string, { status: string }>;
  catalogState?: string;
}): MarketplaceEmptyKind {
  if (input.resultCount > 0) return "results";
  if (input.catalogState === "auth-required") return "auth-required";
  const remotes = Object.entries(input.providers).filter(([id]) => REMOTE_IDS.has(id) || id !== "local");
  const useful = remotes.filter(([, p]) => ["online", "needs-key", "disabled"].includes(p.status));
  const failed = remotes.filter(([, p]) => ["slow", "offline", "error", "rate-limited", "auth-required"].includes(p.status));
  if (input.catalogState === "offline" || (failed.length && !useful.length && !input.fromCache)) return "offline";
  if (failed.length) return "provider-failure";
  return "true-empty";
}

export function degradedBanner(providers: Record<string, { status: string; name?: string }>, fromCache = false): string | undefined {
  const rows = Object.entries(providers);
  const official = rows.find(([id]) => id === "official")?.[1];
  const onlineRemotes = rows.filter(([id, p]) => id !== "local" && p.status === "online");
  const slow = rows.filter(([, p]) => p.status === "slow");
  const auth = rows.filter(([, p]) => p.status === "auth-required");
  const offline = rows.filter(([id, p]) => id !== "local" && (p.status === "offline" || p.status === "error"));
  if (auth.length && onlineRemotes.length) return "Cloud account/session requires attention. Showing public registry discovery.";
  if (official?.status === "slow" && onlineRemotes.length) {
    return "Official Registry is responding slowly. Showing results from available sources.";
  }
  if (fromCache && offline.length && !onlineRemotes.length) return "Offline · showing cached catalog";
  if (offline.length && onlineRemotes.length) return "Some registries are unavailable";
  if (slow.length && onlineRemotes.length) return `${slow[0][1].name ?? "A registry"} is responding slowly. Showing results from available sources.`;
  if (offline.length && !onlineRemotes.length && fromCache) return "Marketplace is temporarily offline.";
  if (offline.length && !onlineRemotes.length) return "Marketplace is temporarily offline.";
  return undefined;
}

export function shouldKeepPreviousResults(input: {
  incomingCount: number;
  emptyKind: MarketplaceEmptyKind;
  hadResults: boolean;
}): boolean {
  if (input.incomingCount > 0) return false;
  if (input.emptyKind === "true-empty") return false;
  return input.hadResults;
}

export function latestOnly<T>(generation: { current: number }, mine: number, value: T): T | undefined {
  return generation.current === mine ? value : undefined;
}

export function providerDots(providers: Record<string, { status: string }>): { id: string; label: string; filled: boolean; title: string }[] {
  const order = [
    { id: "official", label: "Official" },
    { id: "glama", label: "Glama" },
    { id: "smithery", label: "Smithery" },
  ];
  return order.map((row) => {
    const status = providers[row.id]?.status ?? "disabled";
    const filled = status === "online" || status === "slow";
    return { id: row.id, label: row.label, filled, title: `${row.label}: ${status}` };
  });
}

export function healthToProviders(health: { id: string; name: string; status: string; detail?: string; latencyMs?: number; resultCount?: number }[]): Record<string, ProviderStatusView> {
  const out: Record<string, ProviderStatusView> = {};
  for (const h of health) {
    out[h.id] = {
      id: h.id,
      name: h.name,
      status: (h.status as ProviderDotStatus) || "error",
      detail: h.detail,
      latencyMs: h.latencyMs,
      resultCount: h.resultCount,
    };
  }
  return out;
}

export function diagnosticsLine(providers: Record<string, ProviderStatusView>, cache?: string): string {
  const parts = Object.values(providers).map((p) => {
    if (p.status === "slow" || p.status === "offline" || p.status === "error") return `${p.name}: ${p.status}`;
    const n = p.resultCount ?? 0;
    const ms = p.latencyMs != null ? ` / ${p.latencyMs}ms` : "";
    return `${p.name}: ${n} results${ms}`;
  });
  if (cache) parts.push(`Cache: ${cache}`);
  return parts.join(" · ");
}

export function mergeCatalogPreferIncoming(previous: MarketServer[], incoming: MarketServer[], keepPrevious: boolean): MarketServer[] {
  if (!keepPrevious) return incoming;
  if (incoming.length) return incoming;
  return previous;
}
