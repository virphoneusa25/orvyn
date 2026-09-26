// scripts/acceptance/capability-ui.mjs
//
// The desktop app, end to end: a chat question that needs the web, with the
// web search blocked. ORION does not say "web search isn't available" — the
// reply shows an install card, and the card opens Tools & MCP → Marketplace.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/capability-ui.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";
import { createRequire } from "node:module";

const PORT = 4791, MODEL_PORT = 4792, SEARCH_PORT = 4793, MCP_PORT = 4794;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "sources-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-capui-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-capui-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-capui-projects-"));
const OUT = process.env.OUT_DIR || work;

// A private MCP registry listing a real "Web Search" MCP server (Streamable HTTP).
const req0 = createRequire(join(resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", ".."), "apps", "backend", "package.json"));
const { McpServer } = req0("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = req0("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = req0("zod");
const mcpCalls = [];
const registryRow = { server: { name: "io.example/web-search", title: "Web Search", description: "Search the web from any MCP client. No API key.", version: "1.0.0", remotes: [{ type: "streamable-http", url: `http://127.0.0.1:${MCP_PORT}/mcp` }] } };
const mcpHttp = createServer(async (req, res) => {
  if (req.url?.startsWith("/v0.1/servers")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify(/versions/.test(req.url) ? registryRow : { servers: [registryRow], metadata: {} })); }
  if (!req.url?.startsWith("/mcp")) { res.writeHead(404); return res.end(); }
  let raw = ""; for await (const c of req) raw += c;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = new McpServer({ name: "web-search", version: "1.0.0" });
  server.tool("web_search", "Search the web.", { query: z.string() }, async ({ query }) => { mcpCalls.push(query); return { content: [{ type: "text", text: "1. KEXP 90.3 FM\n   https://www.kexp.org\n   Live player and DJ profiles" }] }; });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
});

// The question from the user's screenshot, with the web search blocked.
const Q = "can you search other websites for examples of radio station sites?";
const ASK = "I need Web Search to look at live sites — approve the install below and I'll continue.";
const LIVE = "From a live search: KEXP (kexp.org) has a live player and DJ profiles.";
const search = createServer((req, res) => { searches.push(req.url); res.writeHead(403, { "Content-Type": "text/html" }); res.end("blocked"); });
const searches = [];
const modes = [];

function nextTurn(body) {
  const msgs = body.messages ?? [];
  if (String(msgs[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- ok" };
  if (String(msgs[0]?.content ?? "").includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  modes.push(tools.join(","));
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  const mcpSearch = tools.find((n) => /^mcp__/.test(n) && /search/.test(n));
  if (toolMsgs.some((t) => /kexp\.org/.test(String(t.content)))) return { text: LIVE };
  if (mcpSearch) return { text: "", call: { name: mcpSearch, args: { query: "radio station websites" } } };
  if (toolMsgs.some((t) => /approve installing/.test(String(t.content)))) return { text: ASK };
  if (!toolMsgs.length && tools.includes("web_search")) return { text: "", call: { name: "multi_tool_use.parallel", args: { tool_uses: [{ recipient_name: "functions.web_search", parameters: { query: "radio station website examples" } }] } } };
  if (toolMsgs.some((t) => /install card|card to add an MCP tool/.test(String(t.content)))) return { text: ASK };
  return { text: "I tried to search live websites, but web search isn't available in this session." };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }] }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.end("data: [DONE]\n\n");
  });
});

// ---- helpers -------------------------------------------------------------------
// Local engine, no account: the same (default) tenant the desktop uses.
const H = { "Content-Type": "application/json" };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function waitFor(fn, ms = 20_000, every = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(every); }
  return last;
}

function screen(name) {
  const file = join(OUT, name);
  try { execFileSync("import", ["-window", "root", file], { stdio: "ignore" }); return file; } catch { return null; }
}


function startBackend(env, log) {
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  return server;
}
async function healthy() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return true; } catch {} await sleep(250); }
  return false;
}
async function launchApp() {
  const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env } });
  const win = await app.firstWindow();
  win.on("console", (m) => { if (process.env.DEBUG) console.log("[renderer]", m.type(), m.text().slice(0, 300)); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.setPosition(0, 0); });
  await win.waitForSelector("text=Run mission", { timeout: 30_000 });
  return { app, win };
}
const chatFile = () => { try { return JSON.parse(readFileSync(join(userData, "orvyn-chats.json"), "utf8")); } catch { return null; } };


async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => search.listen(SEARCH_PORT, "127.0.0.1", r));
  await new Promise((r) => mcpHttp.listen(MCP_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_WEB_SEARCH_URL: `http://127.0.0.1:${SEARCH_PORT}/html/`,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.BRAVE_SEARCH_API_KEY;
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const log = [];
  const server = startBackend(env, log);
  let app, win;
  try {
    ok(await healthy(), "ORVYN's engine started");
    await api("/mcp/marketplace/registries", "POST", { id: "test", name: "Test registry", url: `http://127.0.0.1:${MCP_PORT}`, enabled: true });
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    ({ app, win } = await launchApp());

    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(Q);
    await win.getByRole("button", { name: /Run mission/ }).click();
    const card = win.locator('[data-testid="chat-capability"]');
    ok(!!(await waitFor(async () => (await card.count()) === 1, 40_000, 300)), "the chat reply shows an install card");
    const body = await win.locator("body").innerText();
    ok(/ORION wants to install Web Search/.test(await card.innerText()), "…asking to install Web Search (found by ORION)", await card.innerText().catch(() => ""));
    ok(body.includes(ASK.slice(0, 40)), "ORION asks the user to approve the install");
    ok(!/isn't available in this session|couldn't resolve the search tool/.test(body), "…and never says the tool is unavailable");
    ok(searches.length >= 1, "the built-in search really was tried first");
    await win.screenshot({ path: join(OUT, "capability-card.png") }).catch(() => {});
    await card.locator('[data-testid="capability-install"]').click();
    ok(!!(await waitFor(async () => (await win.locator("body").innerText()).includes(LIVE), 45_000, 300)), "one click: ORVYN installed it and ORION continued with a live search", (await win.locator("body").innerText()).slice(-600));
    ok(mcpCalls.length >= 1, "…using the installed Web Search tool");
    const servers = (await api("/mcp/servers")).json.servers ?? [];
    ok(servers.some((x) => /Web Search/.test(x.name ?? "")), "Web Search shows as installed in Tools & MCP", JSON.stringify(servers).slice(0, 300));
    await win.screenshot({ path: join(OUT, "capability-continued.png") }).catch(() => {});
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("capability-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close(); search.close(); mcpHttp.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500) + "\nmodes: " + JSON.stringify(modes));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nCAPABILITY UI: PASS" : `\nCAPABILITY UI: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
