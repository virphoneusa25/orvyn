import { AITool, ToolResult } from "../ToolTypes";
import type { MarketplaceService } from "../../mcp/marketplace/service";
import { builtinComputerUseHit } from "../../computerUse/modelComputerCapabilities";

export function makeSearchCapabilitiesTool(market: () => MarketplaceService): AITool {
  return {
    name: "search_capabilities",
    description:
      "Discover MCP tools and servers by capability without loading the catalog into context. " +
      "Use when you need GitHub, Postgres, Slack, email, DNS, JavaScript, Python, filesystem, etc. and do not already have a matching mcp.* tool. " +
      "Returns a small ranked list. If a server is not installed, tell the user why it is needed and ask them to install it from Tools & MCP → Marketplace. " +
      "Official public MCP servers install into the user's local desktop without a platform API key. Never install executable servers yourself.",
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
      const { hits, activated, askInstall, diagnostics } = await market().index.search(query);
      const lines: string[] = [`Capability search for “${query}” (${hits.length} hits).`];
      if (builtinComputerUseHit(query)) {
        lines.push("- [orvyn] computer_use · ORVYN — Desktop/Browser control via computer_screenshot, computer_click, computer_type. Independent of MCP and of provider-native computer-use APIs.");
      }
      if (activated.length) lines.push(`Activated for this run (schema budget ${diagnostics.maxServers} servers / ${diagnostics.maxTools} tools, ~${diagnostics.tokenFootprint} tokens): ${activated.slice(0, 12).join(", ")}`);
      for (const h of hits.slice(0, 10)) {
        lines.push(`- [${h.kind}${h.installed ? ", installed" : ""}] ${h.name} · ${h.server} — ${h.description.slice(0, 140)}`);
      }
      const recommended = askInstall.map((h) => ({
        name: h.name,
        server: h.server,
        canonicalId: h.canonicalId,
        description: h.description,
        freeInstall: Boolean(h.freeInstall),
      }));
      if (askInstall.length) {
        const primary = askInstall[0].name;
        const free = recommended[0]?.freeInstall;
        lines.push(
          `ORION needs ${primary} to complete “${query}”. Ask the user to install it from Tools & MCP → Marketplace` +
            (free ? " — official public servers do not need an API key" : "") +
            `. Do not install executable servers yourself. Options: ` +
            askInstall.map((h) => h.name).join(", ")
        );
      }
      return {
        ok: true,
        output: lines.join("\n"),
        meta: {
          activated,
          diagnostics,
          ...(askInstall.length
            ? {
                capabilityRequired: {
                  query,
                  reason: recommended[0]?.freeInstall
                    ? `ORION needs ${askInstall[0].name} to ${query}. Official public MCP servers install on this desktop with no API key.`
                    : `ORION needs ${askInstall[0].name} to ${query}.`,
                  recommendedServers: recommended,
                },
              }
            : {}),
        },
      };
    },
  };
}
