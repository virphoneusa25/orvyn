// apps/backend/src/mcp/McpTypes.ts
//
// The MCP host's data model. ORVYN acts as an MCP HOST: it spawns/connects
// external MCP servers, discovers their capabilities, and exposes their
// tools to ORION through the SAME ToolGateway used by native tools —
// namespaced as mcp.<server>.<tool>. MCP extends the native runtime; it
// never replaces it.

export type McpTransportKind = "stdio" | "http";

export type McpConnectionState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "ERROR" | "DISABLED";

/** Risk classification for permission policy (spec PHASE 5). */
export type McpToolRisk = "READ" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL_SIDE_EFFECT";

export type McpPermissionMode = "ALLOW" | "ASK" | "DENY";

/** Persisted server configuration. Secrets live SEPARATELY (McpRegistry
 *  secret store) so config never carries credentials in the clear. */
export interface McpServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: McpTransportKind;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http
  url?: string;
  headers?: Record<string, string>;
  authType?: "none" | "bearer" | "custom";
  /** Names of secrets held in the secure store (values never in config). */
  secretNames?: string[];
  /** Marketplace provenance — optional; existing manual servers omit these. */
  version?: string;
  packageIdentifier?: string;
  marketplaceId?: string;
  sourceProviders?: string[];
  scope?: "global" | "project" | "run";
  executionLocation?: "local" | "cloud" | "remote";
  // runtime metadata (cached, not authoritative)
  lastConnectedAt?: number;
  lastError?: string;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  createdAt: number;
  updatedAt: number;
}

/** A discovered tool from a connected server. */
export interface McpToolInfo {
  serverId: string;
  serverName: string;
  originalName: string;
  /** mcp.<server>.<tool> — the name ORION sees. */
  namespacedName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  risk: McpToolRisk;
}

export interface McpServerStatus {
  id: string;
  name: string;
  transport: McpTransportKind;
  state: McpConnectionState;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  lastConnectedAt?: number;
  lastError?: string;
  enabled: boolean;
  tools: { name: string; risk: McpToolRisk; permission: McpPermissionMode; description: string }[];
}

/** Effective permission for a tool: tool override > server override > risk default. */
export interface McpPermissionPolicy {
  serverDefaults: Partial<Record<McpToolRisk, McpPermissionMode>>;
  toolOverrides: Record<string, McpPermissionMode>; // original tool name → mode
}
