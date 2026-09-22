// apps/backend/src/mcp/McpManager.ts
//
// The MCP HOST orchestrator. Owns connections (one McpClient per enabled
// server), registers adapted tools into the shared ToolGateway under
// mcp.<server>.<tool>, emits runtime events, answers status/search, and
// never lets one bad server crash ORVYN.
//
// Design rules from the spec:
// - MCP EXTENDS the native runtime; native tools are never removed.
// - Every tool flows through the same permission/approval engine.
// - Connection states are authoritative — never hardcoded green.
// - Secrets never enter config, logs, events, or model-visible context.

import { randomUUID } from "crypto";
import { ToolGateway } from "../gateway/ToolGateway";
import { classifyTool, effectivePermission, toGatewayPermission } from "./McpPermissionService";
import { makeMcpTool, sanitizeToolName } from "./McpToolAdapter";
import { McpClient } from "./McpClient";
import { McpRegistry } from "./McpRegistry";
import type { DiscoveredTool } from "./McpClient";
import type {
  McpConnectionState,
  McpPermissionMode,
  McpPermissionPolicy,
  McpServerConfig,
  McpServerStatus,
  McpToolInfo,
} from "./McpTypes";

interface Connection {
  state: McpConnectionState;
  client: McpClient | null;
  tools: McpToolInfo[];
  lastError?: string;
}

export interface McpEventSink {
  (type: "mcp.connected" | "mcp.disconnected" | "mcp.error", data: Record<string, unknown>): void;
}

export interface McpManagerDeps {
  gateway: ToolGateway;
  /** Capability declarations for MCP tools (risk → capability classes). */
  engine?: { declareCapabilities(name: string, caps: string[]): void; forgetCapabilities(name: string): void };
  store: { getSetting(k: string): unknown; setSetting(k: string, v: string): void; deleteSetting?(k: string): void };
  /** Emits MCP lifecycle events into the app's event surface (no secrets). */
  onEvent?: McpEventSink;
}

const CALL_TIMEOUT = Number(process.env.ORVYN_MCP_CALL_TIMEOUT_MS) || 120_000;
const CONNECT_TIMEOUT = Number(process.env.ORVYN_MCP_CONNECT_TIMEOUT_MS) || 30_000;
const MAX_LOCAL_PROCESSES = Number(process.env.ORVYN_MCP_MAX_LOCAL) || 16;

/** MCP risk classes mapped onto the engine's capability vocabulary. */
const RISK_CAPS: Record<string, string[]> = {
  READ: ["READ"],
  WRITE: ["READ", "WRITE"],
  DESTRUCTIVE: ["READ", "WRITE", "DELETE"],
  EXTERNAL_SIDE_EFFECT: ["READ", "EXECUTE", "NETWORK"],
};

export class McpManager {
  private registry: McpRegistry;
  private connections = new Map<string, Connection>();
  private gateway: ToolGateway;
  private engine?: McpManagerDeps["engine"];
  private sink?: McpEventSink;
  private store: McpManagerDeps["store"];
  private starting = false;

  constructor(deps: McpManagerDeps) {
    this.gateway = deps.gateway;
    this.engine = deps.engine;
    this.store = deps.store;
    this.sink = deps.onEvent;
    this.registry = new McpRegistry(deps.store);
  }

  // ---- CRUD ---------------------------------------------------------------

  listServers(): McpServerConfig[] {
    return this.registry.list();
  }

  addServer(input: {
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    description?: string;
    secretValues?: Record<string, string>;
    version?: string;
    packageIdentifier?: string;
    marketplaceId?: string;
    sourceProviders?: string[];
    scope?: "global" | "project" | "run";
    executionLocation?: "local" | "cloud" | "remote";
  }): McpServerConfig {
    const id = `mcp_${randomUUID().slice(0, 8)}`;
    const secretNames = input.secretValues ? Object.keys(input.secretValues) : [];
    const cfg: McpServerConfig = {
      id,
      name: input.name.trim() || id,
      description: input.description,
      enabled: false, // saved DISABLED until a successful connect/test
      transport: input.transport,
      command: input.command,
      args: input.args,
      env: input.env,
      cwd: input.cwd,
      url: input.url,
      headers: input.headers,
      authType: input.secretValues && Object.keys(input.secretValues).length ? "bearer" : "none",
      secretNames,
      version: input.version,
      packageIdentifier: input.packageIdentifier,
      marketplaceId: input.marketplaceId,
      sourceProviders: input.sourceProviders,
      scope: input.scope,
      executionLocation: input.executionLocation ?? (input.transport === "http" ? "remote" : "local"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    for (const [k, v] of Object.entries(input.secretValues ?? {})) this.registry.setSecret(id, k, v);
    this.registry.upsert(cfg, this.store);
    return cfg;
  }

  updateServer(id: string, patch: Partial<McpServerConfig> & { secretValues?: Record<string, string> }): McpServerConfig | null {
    const cfg = this.registry.get(id);
    if (!cfg) return null;
    const { secretValues, ...rest } = patch;
    for (const [k, v] of Object.entries(secretValues ?? {})) this.registry.setSecret(id, k, v);
    const next = { ...cfg, ...rest, updatedAt: Date.now() };
    this.registry.upsert(next, this.store);
    return next;
  }

  removeServer(id: string): boolean {
    if (!this.registry.get(id)) return false;
    void this.disconnect(id).catch(() => {});
    this.unregisterTools(id);
    this.registry.remove(id, this.store);
    return true;
  }

  setEnabled(id: string, enabled: boolean): McpServerConfig | null {
    const updated = this.updateServer(id, { enabled });
    if (!updated) return null;
    if (!enabled) {
      void this.disconnect(id).catch(() => {});
      this.unregisterTools(id);
      this.connections.set(id, { state: "DISABLED", client: null, tools: [] });
    }
    return updated;
  }

  // ---- Connection lifecycle ----------------------------------------------

  async connect(id: string): Promise<McpServerStatus> {
    const cfg = this.registry.get(id);
    if (!cfg) throw new Error("Unknown MCP server");
    if (cfg.transport === "stdio") {
      const liveStdio = this.registry.list().filter((c) => {
        if (c.id === id || c.transport !== "stdio") return false;
        const st = this.connections.get(c.id)?.state;
        return st === "CONNECTED" || st === "CONNECTING";
      }).length;
      if (liveStdio >= MAX_LOCAL_PROCESSES) throw new Error(`Local MCP process budget reached (${MAX_LOCAL_PROCESSES}). Disable another server first.`);
    }
    await this.disconnect(id).catch(() => {});
    const conn: Connection = { state: "CONNECTING", client: null, tools: [] };
    this.connections.set(id, conn);
    try {
      const headers = this.registry.resolveHeaders(id, cfg.headers);
      const client = new McpClient(
        {
          transport: cfg.transport,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          cwd: cfg.cwd,
          url: cfg.url,
          headers,
          callTimeoutMs: CALL_TIMEOUT,
          onClosed: () => {
            // Process exit / transport death — flip state, keep ORVYN alive.
            const c = this.connections.get(id);
            if (c && c.state === "CONNECTED") {
              c.state = "ERROR";
              c.lastError = "Connection closed unexpectedly";
              this.sink?.("mcp.disconnected", { serverId: id, name: cfg.name, reason: "closed" });
            }
          },
        },
        cfg.name
      );
      conn.client = client;
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Connect timed out after ${CONNECT_TIMEOUT}ms`)), CONNECT_TIMEOUT)
        ),
      ]);
      const discovered: DiscoveredTool[] = await client.listTools();
      const resources = await client.listResources();
      const prompts = await client.listPrompts();
      const tools: McpToolInfo[] = discovered.map((t) => ({
        serverId: id,
        serverName: cfg.name,
        originalName: t.name,
        namespacedName: `mcp.${sanitizeToolName(cfg.name)}.${sanitizeToolName(t.name)}`,
        description: t.description ?? "",
        inputSchema: t.inputSchema,
        risk: classifyTool({ name: t.name, description: t.description, annotations: t.annotations }),
      }));
      conn.state = "CONNECTED";
      conn.tools = tools;
      this.updateServer(id, {
        // A successful connect is the definition of "enabled".
        enabled: true,
        lastConnectedAt: Date.now(),
        lastError: undefined,
        toolCount: tools.length,
        resourceCount: resources.length,
        promptCount: prompts.length,
      });
      this.registerTools(id, cfg.name, tools);
      this.sink?.("mcp.connected", { serverId: id, name: cfg.name, tools: tools.length });
    } catch (err: any) {
      conn.state = "ERROR";
      conn.lastError = String(err?.message ?? err).slice(0, 300);
      await conn.client?.close().catch(() => {});
      conn.client = null;
      this.updateServer(id, { lastError: conn.lastError });
      this.sink?.("mcp.error", { serverId: id, name: cfg.name, error: conn.lastError });
    }
    return this.status(id)!;
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (conn?.client) await conn.client.close();
    this.connections.set(id, { state: "DISCONNECTED", client: null, tools: [] });
    this.unregisterTools(id);
  }

  async reconnect(id: string): Promise<McpServerStatus> {
    return this.connect(id);
  }

  /** Called at app start: reconnect enabled servers (best-effort). */
  async startEnabled(): Promise<void> {
    if (this.starting) return;
    this.starting = true;
    for (const cfg of this.registry.list().filter((c) => c.enabled)) {
      await this.connect(cfg.id).catch(() => {}); // connect() already isolates failures
    }
    this.starting = false;
  }

  // ---- Gateway registration ----------------------------------------------

  /**
   * Re-bind connected MCP tools into ToolGateway after a registry.clear()
   * (every ORION run calls registerProjectToolsFor). Connections stay up;
   * only the gateway entries are rewritten. Does not spawn or listTools.
   */
  reregisterConnectedTools(): void {
    for (const cfg of this.registry.list()) {
      const conn = this.connections.get(cfg.id);
      if (!conn || conn.state !== "CONNECTED" || conn.tools.length === 0) continue;
      this.registerTools(cfg.id, cfg.name, conn.tools);
    }
  }

  private registerTools(serverId: string, serverName: string, tools: McpToolInfo[]): void {
    const policy = this.registry.policy(serverId);
    for (const t of tools) {
      const mode = effectivePermission(t.risk, policy, t.originalName);
      const tool = makeMcpTool(t, async (args) => {
        const conn = this.connections.get(serverId);
        if (!conn || conn.state !== "CONNECTED" || !conn.client) {
          return { ok: false, output: "", error: `MCP server "${serverName}" is not connected. Ask the user to reconnect it from Tools & MCP.` };
        }
        const res = await conn.client.callTool(t.originalName, args);
        return { ok: res.ok, output: res.output, error: res.isError ? res.output : undefined };
      });
      this.gateway.register(tool);
      this.gateway.setPermission(tool.name, toGatewayPermission(mode));
      // MCP risk → existing capability vocabulary, so role checks pass
      // for appropriate agents instead of defaulting to SYSTEM.
      this.engine?.declareCapabilities(tool.name, RISK_CAPS[t.risk]);
    }
  }

  private unregisterTools(serverId: string): void {
    const conn = this.connections.get(serverId);
    for (const t of conn?.tools ?? []) {
      // The registry has no unregister; permissions reset via setPermission
      // and the tool is overwritten with a denied stub to remove availability.
      this.gateway.setPermission(t.namespacedName, "denied");
      this.engine?.forgetCapabilities(t.namespacedName);
    }
    if (conn) conn.tools = [];
  }

  // ---- Permissions --------------------------------------------------------

  setToolPermission(serverId: string, originalToolName: string, mode: McpPermissionMode): void {
    const policy = this.registry.policy(serverId);
    policy.toolOverrides = { ...policy.toolOverrides, [originalToolName]: mode };
    this.registry.setPolicy(serverId, policy, this.store);
    const conn = this.connections.get(serverId);
    const tool = conn?.tools.find((t) => t.originalName === originalToolName);
    if (tool) this.gateway.setPermission(tool.namespacedName, toGatewayPermission(mode));
  }

  setServerDefaults(serverId: string, defaults: Partial<Record<string, McpPermissionMode>>): void {
    const policy = this.registry.policy(serverId);
    policy.serverDefaults = defaults as McpPermissionPolicy["serverDefaults"];
    this.registry.setPolicy(serverId, policy, this.store);
    // Re-apply to currently registered tools.
    const conn = this.connections.get(serverId);
    for (const t of conn?.tools ?? []) {
      this.gateway.setPermission(t.namespacedName, toGatewayPermission(effectivePermission(t.risk, policy, t.originalName)));
    }
  }

  // ---- Status / discovery / search ---------------------------------------

  status(id: string): McpServerStatus | null {
    const cfg = this.registry.get(id);
    if (!cfg) return null;
    const conn = this.connections.get(id);
    const state: McpConnectionState = !cfg.enabled
      ? conn?.state === "ERROR" ? conn.state : "DISABLED"
      : conn?.state ?? "DISCONNECTED";
    const policy = this.registry.policy(id);
    return {
      id: cfg.id,
      name: cfg.name,
      transport: cfg.transport,
      state,
      toolCount: conn?.tools.length ?? cfg.toolCount ?? 0,
      resourceCount: cfg.resourceCount ?? 0,
      promptCount: cfg.promptCount ?? 0,
      lastConnectedAt: cfg.lastConnectedAt,
      lastError: conn?.lastError ?? cfg.lastError,
      enabled: cfg.enabled,
      tools: (conn?.tools ?? []).map((t) => ({
        name: t.originalName,
        risk: t.risk,
        permission: effectivePermission(t.risk, policy, t.originalName),
        description: t.description.slice(0, 160),
      })),
    };
  }

  statuses(): McpServerStatus[] {
    return this.registry.list().map((c) => this.status(c.id)!).filter(Boolean);
  }

  /** Tool search across native + MCP tools (context-efficient discovery). */
  searchTools(query: string): { name: string; source: "native" | string; description: string }[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const native = this.gateway
      .list()
      .filter((t) => !t.name.startsWith("mcp."))
      .map((t) => ({ name: t.name, source: "native" as const, description: t.description }));
    const mcp: { name: string; source: string; description: string }[] = [];
    for (const conn of this.connections.values()) {
      for (const t of conn.tools) {
        mcp.push({ name: t.namespacedName, source: t.serverName, description: t.description });
      }
    }
    const all = [...native, ...mcp];
    return all
      .map((t) => {
        const name = t.name.toLowerCase();
        const desc = t.description.toLowerCase();
        let score = 0;
        if (name === q) score += 100;
        if (name.includes(q)) score += 50;
        const words = q.split(/\s+/).filter(Boolean);
        for (const w of words) {
          if (name.includes(w)) score += 10;
          if (desc.includes(w)) score += 4;
        }
        return { ...t, score };
      })
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(({ name, source, description }) => ({ name, source, description }));
  }

  /** Compact capability summary for agent context — one line per server. */
  capabilitySummary(): string[] {
    const lines: string[] = [];
    for (const s of this.statuses()) {
      if (s.state !== "CONNECTED" || s.tools.length === 0) continue;
      const sample = s.tools.slice(0, 4).map((t) => t.name).join(", ");
      lines.push(`${s.name}: ${s.tools.length} MCP tools (${sample}${s.tools.length > 4 ? ", …" : ""}) — call via gateway tool names mcp.${s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.<tool>`);
    }
    return lines;
  }
}
