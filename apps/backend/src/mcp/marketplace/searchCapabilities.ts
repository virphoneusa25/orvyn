import type { McpManager } from "../McpManager";
import type { RegistryAggregator } from "./aggregator";
import { isPublicFreeMcp } from "./publicInstall";
import { DEFAULT_TOOL_BUDGET } from "./types";

export interface CapabilityHit {
  kind: "installed" | "marketplace";
  name: string;
  server: string;
  description: string;
  installed: boolean;
  namespacedName?: string;
  canonicalId?: string;
  score?: number;
  trust?: string;
  health?: string;
  scope?: string;
  freeInstall?: boolean;
}

export interface RankContext {
  projectRoot?: string | null;
  inScope?: (serverName: string) => boolean;
  healthOf?: (serverName: string) => { status?: string; lastUsedAt?: number };
  trustOf?: (canonicalId?: string) => string;
}

export class CapabilityIndex {
  activated = new Set<string>();
  budget = { ...DEFAULT_TOOL_BUDGET };
  rankContext: RankContext = {};

  constructor(private manager: McpManager, public aggregator?: RegistryAggregator) {}

  exposeToModel(toolName: string): boolean {
    if (!toolName.startsWith("mcp.")) return true;
    if (toolName === "mcp_list" || toolName === "mcp_call" || toolName === "search_capabilities") return true;
    return this.activated.has(toolName);
  }

  activate(names: string[]): string[] {
    const servers = new Set([...this.activated].map((n) => n.split(".")[1]).filter(Boolean));
    for (const n of names) {
      if (this.activated.size >= this.budget.maxTools) break;
      const server = n.split(".")[1];
      if (server && !servers.has(server) && servers.size >= this.budget.maxServers) continue;
      if (server) servers.add(server);
      this.activated.add(n);
    }
    return [...this.activated];
  }

  diagnostics(): { activated: string[]; maxServers: number; maxTools: number; tokenFootprint: number } {
    const activated = [...this.activated];
    const schemas = this.manager.searchTools
      ? this.manager
          .searchTools(activated.map((n) => n.split(".").pop() ?? n).join(" ") || "mcp")
          .filter((t) => this.activated.has(t.name))
      : [];
    const chars = activated.join(",").length + schemas.reduce((n, t) => n + t.description.length, 0);
    return {
      activated,
      maxServers: this.budget.maxServers,
      maxTools: this.budget.maxTools,
      tokenFootprint: Math.max(1, Math.ceil(chars / 4)),
    };
  }

  async search(query: string): Promise<{
    hits: CapabilityHit[];
    activated: string[];
    askInstall: CapabilityHit[];
    diagnostics: ReturnType<CapabilityIndex["diagnostics"]>;
  }> {
    const q = query.trim().toLowerCase();
    const installed = this.manager.searchTools(query).map((t) => {
      const inScope = this.rankContext.inScope?.(t.source) ?? true;
      const health = this.rankContext.healthOf?.(t.source);
      return {
        kind: "installed" as const,
        name: t.name,
        server: t.source,
        description: t.description,
        installed: t.source !== "native",
        namespacedName: t.name.startsWith("mcp.") ? t.name : undefined,
        health: health?.status,
        scope: inScope ? "in-scope" : "out-of-scope",
        score: rankHit(q, t.name, t.description, {
          installed: t.source !== "native",
          inScope,
          health: health?.status,
          lastUsedAt: health?.lastUsedAt,
        }),
      };
    }).filter((h) => h.scope !== "out-of-scope");

    const mcpInstalled = installed
      .filter((h) => h.namespacedName && (h.health === undefined || h.health === "Healthy" || h.health === "Slow" || h.health === "CONNECTED"))
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    // Installed + allowed tools auto-activate within the budget.
    this.activate(mcpInstalled.map((h) => h.namespacedName!).slice(0, this.budget.maxTools));

    let market: CapabilityHit[] = [];
    if (this.aggregator) {
      const fed = await this.aggregator.search({ query, limit: 8 });
      market = fed.results.map((r) => ({
        kind: "marketplace" as const,
        name: r.server.title || r.server.name,
        server: r.server.name,
        description: r.server.description.slice(0, 220),
        installed: Boolean(r.server.installed),
        canonicalId: r.server.canonicalId,
        trust: r.server.trust?.level ?? this.rankContext.trustOf?.(r.server.canonicalId),
        freeInstall: isPublicFreeMcp(r.server),
        score: rankHit(q, r.server.name, r.server.description, {
          installed: Boolean(r.server.installed),
          trust: r.server.trust?.level,
          official: r.server.sources?.includes("official"),
        }),
      }));
    }
    const askInstall = market.filter((m) => !m.installed).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 5);
    const hits = [...installed, ...market].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 16);
    return { hits, activated: [...this.activated], askInstall, diagnostics: this.diagnostics() };
  }
}

export function rankHit(
  query: string,
  name: string,
  description: string,
  extras: { installed?: boolean; inScope?: boolean; health?: string; lastUsedAt?: number; trust?: string; official?: boolean } = {}
): number {
  const q = query.toLowerCase();
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  let score = 0;
  if (n === q) score += 100;
  if (n.includes(q)) score += 50;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    if (n.includes(w)) score += 10;
    if (d.includes(w)) score += 4;
  }
  if (extras.installed) score += 25;
  if (extras.inScope !== false) score += 8;
  if (extras.health === "Healthy" || extras.health === "CONNECTED") score += 12;
  if (extras.health === "Slow") score += 4;
  if (extras.health === "Needs Auth" || extras.health === "Error" || extras.health === "Offline") score -= 20;
  if (extras.trust === "verified") score += 15;
  if (extras.trust === "community") score += 6;
  if (extras.official) score += 8;
  if (extras.lastUsedAt && Date.now() - extras.lastUsedAt < 7 * 86_400_000) score += 10;
  return score;
}
