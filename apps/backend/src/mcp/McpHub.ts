// apps/backend/src/mcp/McpHub.ts
//
// MCP (Model Context Protocol) client hub. Servers are declared per project in
// .orvyn/mcp.json; agents NEVER import MCP — they reach it only through the
// mcp_list / mcp_call gateway tools registered from this hub.
//
// Two transports:
// - Streamable HTTP (JSON-RPC over POST, with optional SSE-framed responses)
// - stdio (newline-delimited JSON-RPC to a spawned local process) — how most
//   local MCP servers run (npx @modelcontextprotocol/server-*, uvx, …)
//
// Config shape (.orvyn/mcp.json):
// { "servers": {
//     "linear": { "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer …" } },
//     "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] }
// } }

import { promises as fs } from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";

export interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpServerStatus {
  name: string;
  url?: string;
  status: "ready" | "error" | "pending";
  detail?: string;
  toolCount?: number;
}

interface McpSession {
  sessionId: string | null;
  initialized: boolean;
}

const RPC_TIMEOUT_MS = 30_000;

// One spawned process per stdio server, kept alive across calls. MCP stdio
// framing is one JSON-RPC message per line on stdout/stdin.
class StdioMcpSession {
  private proc: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  initialized = false;

  constructor(cfg: McpServerConfig, cwd: string) {
    this.proc = spawn(cfg.command!, cfg.args ?? [], {
      cwd,
      env: { ...process.env, ...(cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: npx/uvx are .cmd shims that need a shell to resolve.
      shell: process.platform === "win32",
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx: number;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
            else p.resolve(msg.result);
          }
          // Notifications/requests from the server are ignored in v1.
        } catch {
          // Non-JSON stdout noise (some servers log there) — skip the line.
        }
      }
    });
    this.proc.on("exit", (code) => {
      const err = new Error(`MCP server process exited (code ${code})`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.initialized = false;
    });
  }

  get alive(): boolean {
    return this.proc.exitCode === null && !this.proc.killed;
  }

  request(method: string, params: Record<string, unknown>): Promise<any> {
    if (!this.alive) return Promise.reject(new Error("MCP server process is not running"));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request "${method}" timed out after ${RPC_TIMEOUT_MS / 1000}s`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.proc.stdin!.write(payload);
    });
  }

  notify(method: string): void {
    if (!this.alive) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  kill(): void {
    try {
      this.proc.kill();
    } catch {
      // Already dead.
    }
  }
}

export class McpHub {
  private servers = new Map<string, McpServerConfig>();
  private sessions = new Map<string, McpSession>();
  private stdioSessions = new Map<string, StdioMcpSession>();
  private configuredRoot: string | null = null;

  /** Loads .orvyn/mcp.json for the project. Missing file = no servers (fine). */
  async configure(projectRoot: string): Promise<void> {
    if (this.configuredRoot === projectRoot) return;
    this.servers.clear();
    this.sessions.clear();
    for (const s of this.stdioSessions.values()) s.kill();
    this.stdioSessions.clear();
    this.configuredRoot = projectRoot;
    try {
      const raw = await fs.readFile(path.join(projectRoot, ".orvyn", "mcp.json"), "utf8");
      const parsed = JSON.parse(raw);
      for (const [name, cfg] of Object.entries(parsed.servers ?? {})) {
        this.servers.set(name, cfg as McpServerConfig);
      }
    } catch {
      // No config or invalid JSON — zero servers, honestly reported.
    }
  }

  serverNames(): string[] {
    return Array.from(this.servers.keys());
  }

  private parseRpcResponse(text: string, contentType: string): any {
    if (contentType.includes("text/event-stream")) {
      // Take the last data: line — streamable HTTP frames the JSON-RPC result as SSE.
      const dataLines = text
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .filter(Boolean);
      if (dataLines.length === 0) throw new Error("Empty SSE response from MCP server");
      return JSON.parse(dataLines[dataLines.length - 1]);
    }
    return JSON.parse(text);
  }

  private async stdioRpc(name: string, cfg: McpServerConfig, method: string, params: Record<string, unknown>): Promise<any> {
    let session = this.stdioSessions.get(name);
    if (!session || !session.alive) {
      session = new StdioMcpSession(cfg, this.configuredRoot ?? process.cwd());
      this.stdioSessions.set(name, session);
    }
    if (!session.initialized && method !== "initialize") {
      await session.request("initialize", {
        protocolVersion: "2025-03-26",
        clientInfo: { name: "orvyn", version: "1.0" },
        capabilities: {},
      });
      session.initialized = true;
      session.notify("notifications/initialized");
    }
    return session.request(method, params);
  }

  private async rpc(name: string, method: string, params: Record<string, unknown>): Promise<any> {
    const cfg = this.servers.get(name);
    if (!cfg) throw new Error(`Unknown MCP server "${name}"`);
    if (!cfg.url && cfg.command) return this.stdioRpc(name, cfg, method, params);
    if (!cfg.url) throw new Error(`MCP server "${name}" has neither a url nor a command in .orvyn/mcp.json.`);

    let session = this.sessions.get(name);
    if (!session) {
      session = { sessionId: null, initialized: false };
      this.sessions.set(name, session);
    }

    if (!session.initialized && method !== "initialize") {
      await this.initialize(name, cfg, session);
    }

    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
        ...(cfg.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP "${name}" HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = this.parseRpcResponse(text, res.headers.get("content-type") ?? "");
    if (json.error) throw new Error(`MCP "${name}" error: ${json.error.message ?? JSON.stringify(json.error)}`);
    return json.result;
  }

  private async initialize(name: string, cfg: McpServerConfig, session: McpSession): Promise<void> {
    const res = await fetch(cfg.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(cfg.headers ?? {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          clientInfo: { name: "orvyn", version: "1.0" },
          capabilities: {},
        },
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) session.sessionId = sid;
    const text = await res.text();
    if (!res.ok) throw new Error(`MCP "${name}" initialize failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    session.initialized = true;
    // Spec requires a notifications/initialized ping; best-effort.
    void fetch(cfg.url!, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(session.sessionId ? { "Mcp-Session-Id": session.sessionId } : {}),
        ...(cfg.headers ?? {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch(() => undefined);
  }

  async listTools(name: string): Promise<{ name: string; description?: string }[]> {
    const result = await this.rpc(name, "tools/list", {});
    return (result.tools ?? []).map((t: any) => ({ name: t.name, description: t.description }));
  }

  async callTool(name: string, tool: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.rpc(name, "tools/call", { name: tool, arguments: args });
    const parts = Array.isArray(result.content) ? result.content : [];
    const text = parts
      .map((p: any) => (p.type === "text" ? p.text : `[${p.type} content]`))
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool reported an error");
    return text || JSON.stringify(result);
  }

  /** Status of every configured server, probing tools/list. For the Agents UI. */
  async statuses(): Promise<McpServerStatus[]> {
    const out: McpServerStatus[] = [];
    for (const [name, cfg] of this.servers) {
      if (!cfg.url && !cfg.command) {
        out.push({ name, status: "error", detail: "config needs a url (HTTP) or command (stdio)" });
        continue;
      }
      try {
        const tools = await this.listTools(name);
        out.push({ name, url: cfg.url, status: "ready", toolCount: tools.length });
      } catch (err: any) {
        out.push({ name, url: cfg.url, status: "error", detail: err.message });
      }
    }
    return out;
  }
}
