import { AITool, ToolResult } from "../ToolTypes";
import type { MarketplaceService } from "../../mcp/marketplace/service";
import { builtinComputerUseHit } from "../../computerUse/modelComputerCapabilities";

export function makeSearchCapabilitiesTool(market: () => MarketplaceService): AITool {
  return {
    name: "search_capabilities",
    description:
      "Discover MCP tools and servers by capability without loading the catalog into context. " +
      "Use when you need GitHub, Postgres, Slack, email, DNS, JavaScript, Python, filesystem, etc. and do not already have a matching mcp.* tool. " +
      "Returns a small ranked list. When the server you need is not installed, ORVYN asks the user to approve installing it and installs it for you; then its tools are available in this run. " +
      "Never tell the user a tool is unavailable.",
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
        secrets: h.secrets ?? [],
        oauth: Boolean(h.oauth),
      }));
      if (askInstall.length) {
        const primary = askInstall[0].name;
        const free = recommended[0]?.freeInstall;
        lines.push(
          `ORION can install ${primary} to complete “${query}”` +
            (free ? " (official public server, no API key)" : "") +
            `. ORVYN asks the user to approve the install and then installs it. Options: ` +
            askInstall.map((h) => `${h.name} (id ${h.canonicalId})`).join(", ")
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

/**
 * Installs an MCP server ORION found (after the user approved it), connects it
 * and returns its tools. Never runs without the user's approval: it is an
 * "ask" tool the access modes never auto-allow.
 */
export function makeInstallMcpServerTool(market: () => MarketplaceService): AITool {
  return {
    name: "install_mcp_server",
    description:
      "Install an MCP server found by search_capabilities (pass its canonical id) so you can use its tools in this run. The user approves every install. " +
      "After it connects, its tools (mcp.<server>.<tool>) are available to you right away.",
    parameters: {
      type: "object",
      properties: {
        canonicalId: { type: "string", description: "The server id from search_capabilities" },
        reason: { type: "string", description: "Why you need it, in one sentence for the user" },
      },
      required: ["canonicalId"],
    },
    defaultPermission: "ask",
    async execute(args, context): Promise<ToolResult> {
      const id = String(args.canonicalId ?? "").trim();
      if (!id) return { ok: false, error: "canonicalId is required" };
      const m = market();
      let server = m.index.serverFor(id);
      if (!server) {
        await m.index.search(id).catch(() => undefined);
        server = m.index.serverFor(id);
      }
      if (!server) return { ok: false, error: `No MCP server with id ${id} was found in the marketplace. Call search_capabilities first.` };
      const secrets = (args.secrets && typeof args.secrets === "object" ? args.secrets : undefined) as Record<string, string> | undefined;
      let out;
      try {
        out = await m.install(server, { connect: true, secrets, cwd: context?.workspaceRoot });
      } catch (err: any) {
        return { ok: false, error: `Installing ${server.title || server.name} failed: ${err?.message ?? err}` };
      }
      const name = server.title || server.name;
      const state = String(out.status?.state ?? "");
      if (out.needsOAuth) return { ok: false, error: `${name} is installed but needs the user to sign in (Tools & MCP → Installed → ${name} → Connect).`, meta: { installed: { serverId: out.config.id, name, tools: [], state: "NEEDS_AUTH" } } };
      if (state !== "CONNECTED") return { ok: false, error: `${name} was installed but did not start (${state || "not connected"}${out.status?.lastError ? `: ${out.status.lastError}` : ""}).`, meta: { installed: { serverId: out.config.id, name, tools: [], state } } };
      const tools = m.manager.namespacedTools(out.config.id);
      m.index.activate(tools.map((t) => t.name));
      return {
        ok: true,
        output: [`Installed and connected ${name}. Its tools are available now:`, ...tools.map((t) => `- ${t.name}: ${t.description}`)].join("\n"),
        meta: { installed: { serverId: out.config.id, name, tools: tools.map((t) => t.name), state } },
      };
    },
  };
}
