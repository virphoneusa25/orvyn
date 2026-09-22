import type { McpManager } from "../McpManager";
import type { RegistryAggregator } from "./aggregator";
import { DEFAULT_TOOL_BUDGET } from "./types";

export interface CapabilityHit {
  kind: "installed" | "marketplace";
  name: string;
  server: string;
  description: string;
  installed: boolean;
  namespacedName?: string;
  canonicalId?: string;
}

export class CapabilityIndex {
  activated = new Set<string>();
  budget = { ...DEFAULT_TOOL_BUDGET };

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

  async search(query: string): Promise<{ hits: CapabilityHit[]; activated: string[]; askInstall: CapabilityHit[] }> {
    const installed = this.manager.searchTools(query).map((t) => ({
      kind: "installed" as const,
      name: t.name,
      server: t.source,
      description: t.description,
      installed: t.source !== "native",
      namespacedName: t.name.startsWith("mcp.") ? t.name : undefined,
    }));
    const mcpInstalled = installed.filter((h) => h.namespacedName);
    this.activate(mcpInstalled.map((h) => h.namespacedName!).slice(0, 8));

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
      }));
    }
    const askInstall = market.filter((m) => !m.installed).slice(0, 5);
    const hits = [...installed, ...market].slice(0, 16);
    return { hits, activated: [...this.activated], askInstall };
  }
}
