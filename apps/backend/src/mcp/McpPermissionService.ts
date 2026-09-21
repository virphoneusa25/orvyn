// apps/backend/src/mcp/McpPermissionService.ts
//
// Risk classification + effective permission resolution for MCP tools.
// Nothing gets unrestricted automatic access: classification is heuristic
// (server-declared annotations first, name/description patterns second) and
// every effective permission flows through the SAME approval engine native
// tools use (allowed / ask / denied on the ToolGateway).

import type { McpPermissionMode, McpPermissionPolicy, McpToolRisk } from "./McpTypes";

// Hints match snake/kebab/camel-delimited MCP names (create_pull_request)
// as well as prose — underscore is a WORD character for \b, so plain \b
// boundaries miss "create_pull_request".
const READ_HINTS = /(?:^|[_\s-])(read|list|get|echo|search|fetch|query|select|show|describe|explain|inspect|view|status|log|blame|diff)(?:$|[_\s-])/i;
const DESTRUCTIVE_HINTS = /(?:^|[_\s-])(delete|remove|drop|destroy|truncate|reset|wipe|purge|force[_ -]?push|rm|uninstall)(?:$|[_\s-])/i;
const SIDE_EFFECT_HINTS = /(?:^|[_\s-])(restart|stop|start|deploy|push|publish|exec|run|invoke|apply|provision|scale|migrate|install|commit|merge|reboot|trigger|fire)(?:$|[_\s-])/i;
const WRITE_HINTS = /(?:^|[_\s-])(create|write|update|edit|patch|insert|upsert|add|set|put|post|make|modify|stage|branch|comment|label|assign|close)(?:$|[_\s-])/i;

/** Heuristic classification: server annotations win when present. */
export function classifyTool(input: {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}): McpToolRisk {
  const a = input.annotations ?? {};
  if (a.destructiveHint === true) return "DESTRUCTIVE";
  if (a.readOnlyHint === true) return "READ";
  const text = `${input.name} ${input.description ?? ""}`;
  if (DESTRUCTIVE_HINTS.test(text)) return "DESTRUCTIVE";
  if (SIDE_EFFECT_HINTS.test(text)) return "EXTERNAL_SIDE_EFFECT";
  if (WRITE_HINTS.test(text)) return "WRITE";
  if (READ_HINTS.test(text)) return "READ";
  // Unknown intent is treated as a side effect — never silently auto-run.
  return "EXTERNAL_SIDE_EFFECT";
}

const RISK_DEFAULTS: Record<McpToolRisk, McpPermissionMode> = {
  READ: "ASK",
  WRITE: "ASK",
  DESTRUCTIVE: "ASK",
  EXTERNAL_SIDE_EFFECT: "ASK",
};

/** Effective permission: tool override → risk default (server-tuned) → ASK. */
export function effectivePermission(
  risk: McpToolRisk,
  policy: McpPermissionPolicy | undefined,
  originalToolName: string
): McpPermissionMode {
  const override = policy?.toolOverrides?.[originalToolName];
  if (override) return override;
  const serverDefault = policy?.serverDefaults?.[risk];
  if (serverDefault) return serverDefault;
  return RISK_DEFAULTS[risk];
}

/** Maps an MCP permission mode onto the gateway's ToolPermission vocabulary. */
export function toGatewayPermission(mode: McpPermissionMode): "allowed" | "ask" | "denied" {
  return mode === "ALLOW" ? "allowed" : mode === "DENY" ? "denied" : "ask";
}
