import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import readline from "node:readline";

const sessions = new Map();
let nextRpcId = 1;

async function config() {
  const raw = await readFile("/workspace/.orvyn/mcp.json", "utf8");
  return JSON.parse(raw).servers ?? {};
}

class StdioSession {
  constructor(name, spec) {
    this.name = name;
    this.proc = spawn(String(spec.command), Array.isArray(spec.args) ? spec.args.map(String) : [], {
      cwd: "/workspace", env: { ...process.env, ...(spec.env ?? {}) }, stdio: ["pipe", "pipe", "pipe"],
    });
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
          msg.error ? pending.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : pending.resolve(msg.result);
        } catch { /* server log line */ }
      }
    });
    this.proc.on("exit", (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`MCP server exited (${code})`));
      this.pending.clear();
    });
  }
  request(method, params) {
    const id = nextRpcId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MCP ${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method) { this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`); }
}

async function stdioRpc(name, spec, method, params) {
  let session = sessions.get(name);
  if (!session || session.proc.exitCode !== null) { session = new StdioSession(name, spec); sessions.set(name, session); }
  if (!session.initialized) {
    await session.request("initialize", { protocolVersion: "2025-03-26", clientInfo: { name: "orvyn-sandbox", version: "1.0" }, capabilities: {} });
    session.initialized = true;
    session.notify("notifications/initialized");
  }
  return session.request(method, params);
}

async function httpRpc(name, spec, method, params) {
  const key = `http:${name}`;
  const sessionId = sessions.get(key) ?? null;
  const response = await fetch(String(spec.url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sessionId ? { "mcp-session-id": sessionId } : {}), ...(spec.headers ?? {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextRpcId++, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  const sid = response.headers.get("mcp-session-id");
  if (sid) sessions.set(key, sid);
  const text = await response.text();
  if (!response.ok) throw new Error(`MCP ${name} HTTP ${response.status}: ${text.slice(0, 300)}`);
  const payload = response.headers.get("content-type")?.includes("text/event-stream")
    ? JSON.parse(text.split(/\r?\n/).filter((x) => x.startsWith("data:")).pop().slice(5).trim())
    : JSON.parse(text);
  if (payload.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error));
  return payload.result;
}

async function rpc(name, spec, method, params) {
  if (spec.command) return stdioRpc(name, spec, method, params);
  if (spec.url) return httpRpc(name, spec, method, params);
  throw new Error(`MCP server ${name} has no command or URL`);
}

async function execute(message) {
  const servers = await config();
  if (message.op === "list") {
    const lines = [];
    for (const [name, spec] of Object.entries(servers)) {
      try {
        const result = await rpc(name, spec, "tools/list", {});
        lines.push(`${name}:`, ...(result.tools ?? []).map((t) => `  - ${t.name}${t.description ? `: ${String(t.description).slice(0, 100)}` : ""}`));
      } catch (error) { lines.push(`${name}: ERROR — ${String(error?.message ?? error)}`); }
    }
    return lines.length ? lines.join("\n") : "No MCP servers configured in .orvyn/mcp.json.";
  }
  const name = String(message.args?.server ?? "");
  const spec = servers[name];
  if (!spec) throw new Error(`Unknown MCP server ${name}`);
  const result = await rpc(name, spec, "tools/call", { name: String(message.args?.tool ?? ""), arguments: message.args?.arguments ?? {} });
  const text = (result.content ?? []).map((part) => part.type === "text" ? part.text : `[${part.type} content]`).join("\n");
  if (result.isError) throw new Error(text || "MCP tool reported an error");
  return (text || JSON.stringify(result)).slice(0, 20_000);
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (!line.trim()) continue;
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  try { process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, output: await execute(message) })}\n`); }
  catch (error) { process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: String(error?.message ?? error).slice(0, 2000) })}\n`); }
}
for (const session of sessions.values()) if (session?.proc) session.proc.kill();
