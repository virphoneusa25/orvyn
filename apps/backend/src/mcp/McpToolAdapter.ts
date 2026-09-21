// apps/backend/src/mcp/McpToolAdapter.ts
//
// Adapts a discovered MCP tool into an AITool for the SAME ToolGateway
// ORION already uses. Namespaced mcp.<server>.<tool>; execution flows
// Manager → client with timeouts; failures return structured errors so the
// runtime's self-correction (identical-retry blocking) applies unchanged.

import { AITool } from "../ai/ToolTypes";
import type { McpToolInfo } from "./McpTypes";

export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
}

export function makeMcpTool(info: McpToolInfo, execute: (args: Record<string, unknown>) => Promise<{ ok: boolean; output: string; error?: string }>): AITool {
  return {
    name: info.namespacedName,
    description: `[${info.serverName} · MCP · ${info.risk}] ${info.description || info.originalName}`.slice(0, 600),
    parameters: info.inputSchema && typeof info.inputSchema === "object" && info.inputSchema.type
      ? info.inputSchema
      : { type: "object", properties: {} },
    defaultPermission: "ask", // always ask by default; the manager sets the real mode via policy
    async execute(args) {
      const res = await execute(args);
      if (res.ok) return { ok: true, output: res.output };
      return { ok: false, error: res.error ?? res.output };
    },
  };
}
