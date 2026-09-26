// scripts/acceptance/capability-install.mjs
//
// ORION finds the MCP tool it needs and installs it after one approval — the
// user never goes looking for it. End to end through the real engine, with a
// scripted model, a blocked web search, a private MCP registry that lists a
// "Web Search" server, and that server running for real (Streamable HTTP):
//
//   1. Agent, user says "Not now": nothing is installed; ORION finishes with
//      what it has and never says a tool is unavailable.
//   2. Agent, user approves: ORVYN installs and connects the server, the run
//      gets its tools, ORION searches with it and answers from the results.
//   3. Chat (fresh engine): the reply carries the install candidate; the card's
//      install call installs it; asking again, the chat searches with it.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/capability-install.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const require = createRequire(join(repoRoot, "apps", "backend", "package.json"));
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

const PORT = 4801, MODEL_PORT = 4802, MCP_PORT = 4803;
const BASE = `http://127.0.0.1:${PORT}`;
const backendCwd = join(repoRoot, "apps", "backend");
const project = mkdtempSync(join(tmpdir(), "orvyn-inst-project-"));
writeFileSync(join(project, "README.md"), "# Radio site\n");
spawnSync("git", ["init", "-q"], { cwd: project });

const SERVER_ID = "io.example/web-search";
const mcpCalls = [];

// ---- a real MCP server (Streamable HTTP, stateless) + a private registry listing it ----
function mcpServer() {
  const s = new McpServer({ name: "web-search", version: "1.0.0" });
  s.tool("web_search", "Search the web and return the top results (title, URL, snippet).", { query: z.string() }, async ({ query }) => {
    mcpCalls.push(query);
    return { content: [{ type: "text", text: `1. KEXP 90.3 FM\n   https://www.kexp.org\n   Live player, playlist, DJ profiles\n2. NTS Radio\n   https://www.nts.live\n   Two live channels and a show archive` }] };
  });
  return s;
}
const registryRow = {
  server: {
    name: SERVER_ID,
    title: "Web Search",
    description: "Search the web from any MCP client. No API key.",
    version: "1.0.0",
    remotes: [{ type: "streamable-http", url: `http://127.0.0.1:${MCP_PORT}/mcp` }],
  },
};
const mcpHttp = createServer(async (req, res) => {
  if (req.url?.startsWith("/v0.1/servers")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    const one = /\/v0\.1\/servers\/[^/?]+\/versions/.test(req.url);
    return res.end(JSON.stringify(one ? registryRow : { servers: [registryRow], metadata: {} }));
  }
  if (req.url?.startsWith("/mcp")) {
    let raw = ""; for await (const c of req) raw += c;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const server = mcpServer();
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    return;
  }
  res.writeHead(404); res.end();
});

// ---- scripted model ----
const ASK_DENIED = "Without live search, KEXP and NTS are good examples; installing Web Search would let me check them live.";
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  if (system.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Checked." };
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const toolMsgs = msgs.filter((m) => m.role === "tool").map((m) => String(m.content));
  const mcpSearch = tools.find((n) => /^mcp__/.test(n) && /search/.test(n));
  if (toolMsgs.some((t) => /kexp\.org/.test(t))) return { text: "From a live search: KEXP (kexp.org) has a live player and DJ profiles; NTS (nts.live) runs two live channels." };
  if (mcpSearch && !toolMsgs.some((t) => /kexp/.test(t))) return { text: "Searching with the new tool.", call: { name: mcpSearch, args: { query: "radio station websites" } } };
  if (toolMsgs.some((t) => /did not approve/.test(t))) return { text: ASK_DENIED };
  if (toolMsgs.some((t) => /asking the user to approve installing|approve installing/.test(t))) return { text: "I need Web Search to look at live sites — approve the install below and I'll continue." };
  if (!toolMsgs.length && tools.includes("web_search")) return { text: "", call: { name: "web_search", args: { query: "radio station websites" } } };
  return { text: "OK." };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.startsWith("/search")) { res.writeHead(403); return res.end("blocked"); }
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const bad = (body.tools ?? []).map((t) => t.function?.name ?? "").filter((n) => !/^[A-Za-z0-9_-]{1,64}$/.test(n));
    if (bad.length) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: `Invalid tool names: ${bad.join(", ")}` } })); }
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });
});

// ---- helpers ----
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function runTask(instruction, answer) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot: project, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
  const runId = started.json.runId; const answered = new Set();
  for (let i = 0; i < 400; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    for (const e of r.json.events ?? []) {
      if (e.type !== "approval.required" || answered.has(e.data.callId)) continue;
      answered.add(e.data.callId);
      await api(`/agent/stream/approvals/${e.data.callId}`, "POST", { approved: answer(e), scope: "once" });
    }
    if (["completed", "error", "cancelled", "blocked"].includes(r.json.status)) return { status: r.json.status, events: r.json.events ?? [] };
    await sleep(200);
  }
  const r = await api(`/agent/stream/runs/${runId}/events.json`); return { status: r.json.status, events: r.json.events ?? [] };
}
const finalText = (ev) => { let t = ""; for (const e of ev) { if (e.type === "message.retracted") t = ""; if (e.type === "message.delta") t += String(e.data.content ?? ""); } return t; };
function chat(userMessage) {
  return new Promise((done) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
    let text = ""; const activity = new Map();
    const fin = () => done({ text, activity: [...activity.values()] });
    sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history: [], userMessage, context: { useRag: false } }));
    sock.onmessage = (ev) => { const c = JSON.parse(ev.data); if (c.retract) text = ""; if (c.activity) activity.set(c.activity.id, c.activity); if (c.delta) text += c.delta; if (c.done) { sock.close(); fin(); } };
    sock.onerror = fin; setTimeout(fin, 60000);
  });
}
async function startEngine(log) {
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = { ...process.env, ORVYN_DATA_DIR: mkdtempSync(join(tmpdir(), "orvyn-inst-data-")), PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent", ORVYN_WEB_SEARCH_URL: `${M}/search` };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.BRAVE_SEARCH_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "CHEAPER_INFERENCE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
  const reg = await api("/mcp/marketplace/registries", "POST", { id: "test", name: "Test registry", url: `http://127.0.0.1:${MCP_PORT}`, enabled: true });
  if (reg.status >= 300) log.push(`registry: ${JSON.stringify(reg)}`);
  return server;
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => mcpHttp.listen(MCP_PORT, "127.0.0.1", r));
  const log = [];
  let server;
  try {
    server = await startEngine(log);

    console.log("\n1. Agent: ORION asks to install Web Search; the user says Not now");
    const a = await runTask("Find examples of radio station websites we can learn from", () => false);
    const askA = a.events.find((e) => e.type === "approval.required" && e.data.install);
    ok(askA?.data?.install?.name === "Web Search" && askA.data.install.canonicalId === SERVER_ID, "ORION found Web Search and asked to install it", JSON.stringify(askA?.data ?? a.events.filter((e) => /capab|approval/.test(e.type)).map((e) => e.data)).slice(0, 400));
    ok(!a.events.some((e) => e.type === "capability.installed") && ((await api("/mcp/servers")).json.servers ?? []).length === 0, "nothing was installed without approval");
    ok(finalText(a.events).endsWith(ASK_DENIED), "ORION finished with what it had, without saying a tool is unavailable", finalText(a.events));

    console.log("\n2. Agent: the user approves; ORVYN installs it and ORION uses it");
    const b = await runTask("Find examples of radio station websites we can learn from", () => true);
    const inst = b.events.find((e) => e.type === "capability.installed");
    ok(inst && inst.data.name === "Web Search" && inst.data.tools.some((t) => /^mcp\..*web_search$/.test(t)), "after one approval ORVYN installed and connected Web Search", JSON.stringify(inst?.data ?? b.events.filter((e) => /tool\.failed|capab/.test(e.type)).map((e) => e.data)).slice(0, 500));
    ok(b.events.some((e) => e.type === "tool.completed" && /^mcp\./.test(e.data.tool)) && mcpCalls.length >= 1, "ORION searched with the new tool in the same run (no second approval)", JSON.stringify({ mcpCalls, approvals: b.events.filter((e) => e.type === "approval.required").length }));
    ok(b.events.filter((e) => e.type === "approval.required").length === 1, "…one approval in total");
    ok(/kexp\.org/.test(finalText(b.events)), "the answer comes from the live results", finalText(b.events));
    server.kill("SIGKILL"); await sleep(500);

    console.log("\n3. Chat (fresh engine): install from the card, then the chat searches with it");
    server = await startEngine(log);
    const c1 = await chat("can you search other websites for examples?");
    const cap = c1.activity.find((x) => x.kind === "capability");
    ok(cap?.install?.canonicalId === SERVER_ID && cap.install.name === "Web Search", "the chat reply carries the install for Web Search", JSON.stringify(c1.activity));
    ok(/approve the install below/.test(c1.text) && !/isn't available/.test(c1.text), "ORION asks the user to approve it", c1.text);
    const installed = await api("/mcp/capability/install", "POST", { canonicalId: cap?.install?.canonicalId });
    ok(installed.json.ok && installed.json.tools?.length >= 1, "the card's Install call installed and connected it", JSON.stringify(installed.json));
    const before = mcpCalls.length;
    const c2 = await chat("can you search other websites for examples?");
    ok(mcpCalls.length > before && /kexp\.org/.test(c2.text), "asked again, the chat searched with Web Search and answered", c2.text);
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
  } finally {
    server?.kill("SIGKILL"); model.close(); mcpHttp.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nCAPABILITY INSTALL: PASS" : `\nCAPABILITY INSTALL: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
