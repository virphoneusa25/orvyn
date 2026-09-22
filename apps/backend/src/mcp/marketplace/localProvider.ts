import type { McpManager } from "../McpManager";
import { inferCategories, trustFor } from "./classify";
import type { MarketplaceMcpServer, McpRegistryProvider, RegistryHealth, RegistryResult, RegistrySearch } from "./types";

export function localProvider(manager: McpManager): McpRegistryProvider {
  return {
    id: "local",
    name: "Installed / manual",
    async health(): Promise<RegistryHealth> {
      return { id: "local", name: "Installed / manual", status: "online", detail: `${manager.listServers().length} configured` };
    },
    async search(query: RegistrySearch) {
      const q = query.query.trim().toLowerCase();
      const results: RegistryResult[] = [];
      for (const cfg of manager.listServers()) {
        const status = manager.status(cfg.id);
        const hay = `${cfg.name} ${cfg.description ?? ""} ${cfg.command ?? ""} ${cfg.url ?? ""}`.toLowerCase();
        if (q && !hay.includes(q) && !q.split(/\s+/).some((w) => hay.includes(w))) continue;
        const server = fromInstalled(cfg, status);
        results.push({ server, score: 80 });
      }
      return { results };
    },
    async getServer(id: string) {
      const cfg = manager.listServers().find((c) => c.id === id || c.name === id);
      return cfg ? fromInstalled(cfg, manager.status(cfg.id)) : null;
    },
  };
}

function fromInstalled(cfg: { id: string; name: string; description?: string; transport: "stdio" | "http"; command?: string; args?: string[]; url?: string; enabled: boolean }, status: ReturnType<McpManager["status"]>): MarketplaceMcpServer {
  return {
    canonicalId: cfg.id,
    name: cfg.name,
    description: cfg.description ?? "Manually configured MCP server",
    sources: ["local"],
    categories: inferCategories(cfg.name, cfg.description ?? ""),
    packages: [],
    transports: [
      cfg.transport === "http"
        ? { kind: "http", url: cfg.url }
        : { kind: "stdio", command: cfg.command, args: cfg.args },
    ],
    tools: (status?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk === "READ" ? "read" : t.risk === "WRITE" ? "write" : t.risk === "DESTRUCTIVE" ? "destructive" : "external-side-effect",
    })),
    auth: [{ kind: "none", label: "Configured locally" }],
    trust: trustFor({ sources: ["local"] }),
    installed: {
      serverId: cfg.id,
      enabled: cfg.enabled,
      state: status?.state ?? "DISCONNECTED",
    },
    compatibility: "compatible",
    compatibilityReason: "Already configured in this ORVYN workspace",
    toolCount: status?.toolCount,
    networkRequired: cfg.transport === "http",
    filesystemScope: "project",
  };
}
