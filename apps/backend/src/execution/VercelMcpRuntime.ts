// apps/backend/src/execution/VercelMcpRuntime.ts

export const VERCEL_MCP_PORT = 9230;

export const VERCEL_MCP_SERVER_SOURCE = String.raw`
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const WORKSPACE = "/vercel/sandbox/workspace";
const sessions = new Map();
let nextRpcId = 1;

async function config() {
  const raw = await readFile(WORKSPACE + "/.orvyn/mcp.json", "utf8");
  return JSON.parse(raw).servers ?? {};
}

class StdioSession {
  constructor(name, spec) {
    this.name = name;
    this.proc = spawn(
      String(spec.command),
      Array.isArray(spec.args) ? spec.args.map(String) : [],
      {
        cwd: WORKSPACE,
        env: { ...process.env, ...(spec.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    this.pending = new Map();
    this.buffer = "";
    this.initialized = false;

    this.proc.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end).trim();
        this.buffer = this.buffer.slice(end + 1);
        try {
          const msg = JSON.parse(line);
          const pending = this.pending.get(msg.id);
          if (!pending) continue;
          this.pending.delete(msg.id);
          msg.error
            ? pending.reject(
                new Error(msg.error.message ?? JSON.stringify(msg.error))
              )
            : pending.resolve(msg.result);
        } catch {}
      }
    });

    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) {
        p.reject(new Error("MCP server exited (" + code + ")"));
      }
      this.pending.clear();
    });
  }

  request(method, params) {
    const id = nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("MCP " + method + " timed out"));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.proc.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
    });
  }

  notify(method) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
}

async function stdioRpc(name, spec, method, params) {
  let session = sessions.get(name);
  if (!session || session.proc.exitCode !== null) {
    session = new StdioSession(name, spec);
    sessions.set(name, session);
  }
  if (!session.initialized) {
    await session.request("initialize", {
      protocolVersion: "2025-03-26",
      clientInfo: { name: "orvyn-vercel-sandbox", version: "1.0" },
      capabilities: {},
    });
    session.initialized = true;
    session.notify("notifications/initialized");
  }
  return session.request(method, params);
}

async function httpRpc(name, spec, method, params) {
  const key = "http:" + name;
  const sessionId = sessions.get(key) ?? null;
  const response = await fetch(String(spec.url), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
      ...(spec.headers ?? {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextRpcId++,
      method,
      params,
    }),
    signal: AbortSignal.timeout(30000),
  });

  const sid = response.headers.get("mcp-session-id");
  if (sid) sessions.set(key, sid);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      "MCP " + name + " HTTP " + response.status + ": " + text.slice(0, 300)
    );
  }

  const payload = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? JSON.parse(
        text
          .split(/\\r?\n/)
          .filter((x) => x.startsWith("data:"))
          .pop()
          .slice(5)
          .trim()
      )
    : JSON.parse(text);

  if (payload.error) {
    throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  }
  return payload.result;
}

async function rpc(name, spec, method, params) {
  if (spec.command) return stdioRpc(name, spec, method, params);
  if (spec.url) return httpRpc(name, spec, method, params);
  throw new Error("MCP server " + name + " has no command or URL");
}

async function execute(message) {
  const servers = await config();

  if (message.op === "list") {
    const lines = [];
    for (const [name, spec] of Object.entries(servers)) {
      try {
        const result = await rpc(name, spec, "tools/list", {});
        lines.push(
          name + ":",
          ...(result.tools ?? []).map(
            (tool) =>
              "  - " +
              tool.name +
              (tool.description
                ? ": " + String(tool.description).slice(0, 100)
                : "")
          )
        );
      } catch (error) {
        lines.push(
          name + ": ERROR — " + String(error?.message ?? error)
        );
      }
    }
    return lines.length
      ? lines.join("\n")
      : "No MCP servers configured in .orvyn/mcp.json.";
  }

  const name = String(message.args?.server ?? "");
  const spec = servers[name];
  if (!spec) throw new Error("Unknown MCP server " + name);

  const result = await rpc(name, spec, "tools/call", {
    name: String(message.args?.tool ?? ""),
    arguments: message.args?.arguments ?? {},
  });
  const text = (result.content ?? [])
    .map((part) =>
      part.type === "text" ? part.text : "[" + part.type + " content]"
    )
    .join("\n");
  if (result.isError) throw new Error(text || "MCP tool reported an error");
  return (text || JSON.stringify(result)).slice(0, 20000);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 2 * 1024 * 1024) {
      res.writeHead(413);
      res.end();
      return;
    }
  }

  try {
    const message = JSON.parse(body || "{}");
    const output = await execute(message);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, output }));
  } catch (error) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: false,
        error: String(error?.message ?? error).slice(0, 2000),
      })
    );
  }
});

server.listen(9230, "127.0.0.1");

async function shutdown() {
  server.close();
  for (const session of sessions.values()) {
    if (session?.proc) session.proc.kill();
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`;
