// apps/backend/src/ai/tools/mcpTools.ts
//
// Generic MCP gateway tools. Agents call mcp_list / mcp_call like any other
// tool; the McpHub (per tenant, configured from .orvyn/mcp.json) is the only
// component that speaks the MCP protocol.

import { AITool, ToolResult } from "../ToolTypes";
import { McpHub } from "../../mcp/McpHub";

export function makeMcpListTool(hub: McpHub, projectRoot: string): AITool {
  return {
    name: "mcp_list",
    description:
      "List the MCP servers configured for this project (.orvyn/mcp.json) and the tools each one exposes.",
    parameters: { type: "object", properties: {} },
    defaultPermission: "allowed",
    async execute(): Promise<ToolResult> {
      await hub.configure(projectRoot);
      const names = hub.serverNames();
      if (names.length === 0) {
        return {
          ok: true,
          output:
            "No MCP servers configured. Add them to .orvyn/mcp.json:\n" +
            '{ "servers": { "name": { "url": "https://…/mcp", "headers": { "Authorization": "Bearer …" } } } }',
        };
      }
      const lines: string[] = [];
      for (const name of names) {
        try {
          const tools = await hub.listTools(name);
          lines.push(`${name}:`);
          for (const t of tools) lines.push(`  - ${t.name}${t.description ? `: ${t.description.slice(0, 100)}` : ""}`);
        } catch (err: any) {
          lines.push(`${name}: ERROR — ${err.message}`);
        }
      }
      return { ok: true, output: lines.join("\n") };
    },
  };
}

export function makeMcpCallTool(hub: McpHub, projectRoot: string): AITool {
  return {
    name: "mcp_call",
    description:
      "Call a tool on a configured MCP server. Use mcp_list first to see servers and tools. Args: server, tool, arguments (object).",
    parameters: {
      type: "object",
      properties: {
        server: { type: "string" },
        tool: { type: "string" },
        arguments: { type: "object" },
      },
      required: ["server", "tool"],
    },
    defaultPermission: "ask",
    async execute(args): Promise<ToolResult> {
      await hub.configure(projectRoot);
      try {
        const output = await hub.callTool(
          String(args.server ?? ""),
          String(args.tool ?? ""),
          (args.arguments as Record<string, unknown>) ?? {}
        );
        return { ok: true, output: output.slice(0, 20_000) };
      } catch (err: any) {
        return { ok: false, error: err.message };
      }
    },
  };
}
