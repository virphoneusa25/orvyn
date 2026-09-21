// apps/backend/src/mcp/McpClient.ts
//
// One MCP client per server, on the official SDK. Transports:
// - stdio  (spawned local process; how most local servers run)
// - http   (Streamable HTTP; the SDK falls back to SSE framing when the
//           server speaks the older transport — genuine need only)
//
// The client is deliberately thin: connect/negotiate/discover/call/close.
// Lifecycle state lives in McpConnection; ORVYN-side registration in
// McpManager.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export interface McpConnectOptions {
  transport: "stdio" | "http";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // http
  url?: string;
  headers?: Record<string, string>;
  /** Request timeout for tool calls, ms. */
  callTimeoutMs?: number;
  onStderr?: (chunk: string) => void;
  onClosed?: () => void;
}

export interface McpServerCapabilities {
  tools: { listChanged: boolean };
  resources: { subscribe: boolean; listChanged: boolean } | undefined;
  prompts: { listChanged: boolean } | undefined;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
}

export class McpClient {
  readonly client: Client;
  private transport: StdioClientTransport | StreamableHTTPClientTransport | null = null;
  private opts: McpConnectOptions;

  constructor(opts: McpConnectOptions, name: string) {
    this.opts = opts;
    this.client = new Client({ name: `orvyn-host-${name}`, version: "0.1.0" });
  }

  async connect(): Promise<McpServerCapabilities> {
    if (this.opts.transport === "stdio") {
      if (!this.opts.command) throw new Error("stdio server requires a command");
      this.transport = new StdioClientTransport({
        command: this.opts.command,
        args: this.opts.args ?? [],
        env: this.opts.env ? { ...this.opts.env } : undefined,
        cwd: this.opts.cwd,
        stderr: "pipe",
      });
      const stdio = this.transport as StdioClientTransport;
      stdio.stderr?.on("data", (d: Buffer) => this.opts.onStderr?.(d.toString()));
    } else {
      if (!this.opts.url) throw new Error("http server requires a url");
      this.transport = new StreamableHTTPClientTransport(new URL(this.opts.url), {
        requestInit: { headers: this.opts.headers ?? {} },
      });
    }
    // onclose fires when the transport dies (process exit, HTTP failure) —
    // the manager flips state; ORVYN itself never crashes with it.
    this.transport.onclose = () => this.opts.onClosed?.();
    await this.client.connect(this.transport);
    const caps = (this.client as unknown as { getServerCapabilities?: () => Record<string, unknown> }).getServerCapabilities?.() ?? {};
    const cap = (k: string) => {
      const v = caps[k] as Record<string, boolean> | undefined;
      return v ? { listChanged: v.listChanged === true } : undefined;
    };
    return {
      tools: cap("tools") ?? { listChanged: false },
      resources: cap("resources") as McpServerCapabilities["resources"],
      prompts: cap("prompts") as McpServerCapabilities["prompts"],
    };
  }

  async listTools(): Promise<DiscoveredTool[]> {
    const res = await this.client.listTools();
    return (res.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      annotations: t.annotations as DiscoveredTool["annotations"],
    }));
  }

  async listResources(): Promise<{ uri: string; name?: string; description?: string }[]> {
    try {
      const res = await this.client.listResources();
      return (res.resources ?? []).map((r) => ({ uri: r.uri, name: r.name, description: r.description }));
    } catch {
      return []; // capability not offered
    }
  }

  async listPrompts(): Promise<{ name: string; description?: string }[]> {
    try {
      const res = await this.client.listPrompts();
      return (res.prompts ?? []).map((p) => ({ name: p.name, description: p.description }));
    } catch {
      return []; // capability not offered
    }
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ ok: boolean; output: string; isError: boolean }> {
    const res = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: this.opts.callTimeoutMs ?? 120_000,
      resetTimeoutOnProgress: true,
    });
    const isError = res.isError === true;
    const text = (Array.isArray(res.content) ? res.content : [])
      .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? `[resource ${c.resource?.uri ?? ""}]` : c.type === "image" ? "[image]" : `[${c.type}]`))
      .join("\n");
    return { ok: !isError, output: text || "(empty result)", isError };
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // already dead — closing must never throw into the manager
    }
    try {
      await this.client.close();
    } catch {
      /* same */
    }
    this.transport = null;
  }
}
