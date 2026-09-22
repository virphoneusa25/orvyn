import { AITool, ToolResult } from "../ToolTypes";
import type { MarketplaceService } from "../../mcp/marketplace/service";

export function makeSearchCapabilitiesTool(market: () => MarketplaceService): AITool {
  return {
    name: "search_capabilities",
    description:
      "Discover MCP tools and servers by capability without loading the catalog into context. " +
      "Use when you need GitHub, Postgres, Slack, email, DNS, etc. and do not already have a matching mcp.* tool. " +
      "Returns a small ranked list. If a server is not installed, tell the user why it is needed and ask them to install it from Tools & MCP → Marketplace — never install executable servers yourself.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you need to do, e.g. 'create GitHub pull request'" },
      },
      required: ["query"],
    },
    defaultPermission: "allowed",
    async execute(args): Promise<ToolResult> {
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, error: "query is required" };
      const { hits, activated, askInstall } = await market().index.search(query);
      const lines: string[] = [`Capability search for “${query}” (${hits.length} hits).`];
      if (activated.length) lines.push(`Activated for this run (schema budget): ${activated.slice(0, 12).join(", ")}`);
      for (const h of hits.slice(0, 10)) {
        lines.push(`- [${h.kind}${h.installed ? ", installed" : ""}] ${h.name} · ${h.server} — ${h.description.slice(0, 140)}`);
      }
      if (askInstall.length) {
        lines.push(
          "Not installed. Ask the user to open Tools & MCP → Marketplace and install one of: " +
            askInstall.map((h) => h.name).join(", ") +
            `. Explain that you need this capability to complete their request.`
        );
      }
      return { ok: true, output: lines.join("\n") };
    },
  };
}
