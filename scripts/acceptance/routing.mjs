// scripts/acceptance/routing.mjs
//
// ORVYN's model routing policy, end to end through the real engine. Every
// provider (Fireworks, Mistral, OpenRouter, Gemini, the GPT/Claude reseller)
// is served by one scripted model that records which model id each call used.
//
//   1. A coding task starts on the Code agent (Kimi K2.7 Code); after three
//      failed tool calls in a row it climbs to GLM-5.3, which finishes.
//   2. A small edit ("Fix the typo …") starts on the cheap code helper (Codestral).
//   3. A server question ("nginx 502") starts on the Server agent (Gemini 3.8 Flash).
//   4. A routine task uses the cheap Auto model (DeepSeek V3.2 via OpenRouter).
//   5. A deep question in chat goes to Gemini 3.8 Flash, not GPT-5.6 Sol.
//   6. Every run is metered in credits; a run over its budget is stopped.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/routing.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4761, MODEL_PORT = 4762;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const project = mkdtempSync(join(tmpdir(), "orvyn-route-project-"));
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-route-data-"));
writeFileSync(join(project, "notes.txt"), "Teh quick brown fox\n");

const MODELS = {
  kimi: "accounts/fireworks/models/kimi-k2p7-code",
  glm: "accounts/fireworks/models/glm-5p3",
  codestral: "codestral-25-08",
  gemini: "gemini-3.8-flash",
  deepseek32: "deepseek/deepseek-v3.2",
  sol: "gpt-5.6-sol",
};
const calls = []; // { model, user }

function toolResultsSinceUser(msgs) {
  const i = msgs.map((m) => m.role).lastIndexOf("user");
  return msgs.slice(i).filter((m) => m.role === "tool");
}

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const user = String([...msgs].reverse().find((m) => m.role === "user" && !/^(Budget note|\[)/.test(String(m.content)))?.content ?? "");
  const m = String(body.model ?? "");
  calls.push({ model: m, user: user.slice(0, 80) });
  if (system.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Checked." };
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const since = toolResultsSinceUser(msgs);
  if (!tools.length || tools.includes("web_search") && !tools.includes("write_file")) return { text: `Answer from ${m}.` };
  if (/Refactor utils/.test(user)) {
    // Kimi keeps reading files that do not exist; GLM-5.3 does the work.
    if (m === MODELS.kimi) return { text: "Reading.", call: { name: "read_file", args: { path: `missing-${since.length}.js` } } };
    if (!since.some((t) => /CREATED|OVERWROTE|Wrote|bytes/i.test(String(t.content)))) return { text: "Writing it.", call: { name: "write_file", args: { path: "utils-a.js", content: "export const a = 1;\n" } } };
    return { text: `Done by ${m}.` };
  }
  if (/Fix the typo/.test(user)) {
    if (!since.length) return { text: "Fixing.", call: { name: "write_file", args: { path: "notes.txt", content: "The quick brown fox\n" } } };
    return { text: `Fixed by ${m}.` };
  }
  if (/nginx/.test(user)) return { text: `The upstream is down (diagnosed by ${m}).` };
  if (/Create five files/.test(user)) {
    // Long-winded: keeps writing files, one per turn.
    return { text: "Next file.", call: { name: "write_file", args: { path: `f${since.length}.txt`, content: "x".repeat(4000) } } };
  }
  if (/Create hello/.test(user)) {
    if (!since.length) return { text: "Creating.", call: { name: "write_file", args: { path: "hello.txt", content: "hi\n" } } };
    return { text: `Created by ${m}.` };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: ["scripted-agent", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5", ...Object.values(MODELS)].map((id) => ({ id })) }));
    }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const toolCalls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    // Report realistic usage: about one token per 4 characters sent.
    const usage = { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 50, total_tokens: Math.ceil(raw.length / 4) + 50 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function runTask(instruction, extra = {}) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot: project, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access", ...extra });
  const runId = started.json.runId;
  let status = "";
  for (let i = 0; i < 240; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    status = r.json.status;
    if (["completed", "error", "cancelled", "blocked"].includes(status)) return { runId, status, events: r.json.events ?? [] };
    await sleep(250);
  }
  const r = await api(`/agent/stream/runs/${runId}/events.json`);
  return { runId, status, events: r.json.events ?? [] };
}
const started = (ev) => ev.find((e) => e.type === "run.started")?.data ?? {};
const lastCredits = (ev) => [...ev].reverse().find((e) => e.type === "run.credits")?.data;

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
    FIREWORKS_API_KEY: "scripted", FIREWORKS_BASE_URL: M,
    CHEAPER_INFERENCE_API_KEY: "scripted", CHEAPER_INFERENCE_BASE_URL: M,
    MISTRAL_API_KEY: "scripted", MISTRAL_BASE_URL: M,
    OPENROUTER_API_KEY: "scripted", OPENROUTER_BASE_URL: M,
    GEMINI_API_KEY: "scripted", GEMINI_OPENAI_BASE_URL: M,
    ORVYN_RUN_CREDITS_AUTO: "20",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.ORVYN_ALLOW_ULTRA_ESCALATION;
  for (const k of ["DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Code agent: Kimi K2.7 Code first, GLM-5.3 after three failed tool calls");
    const code = await runTask("Refactor utils.js into two files", { composerMode: "code" });
    ok(started(code.events).route?.profile === "code" && started(code.events).actualModelId === `fw:${MODELS.kimi}`, "started on the Code agent (Kimi K2.7 Code)", JSON.stringify(started(code.events).route ?? started(code.events)).slice(0, 300));
    const esc = code.events.find((e) => e.type === "route.escalated");
    ok(esc?.data?.modelId === `fw:${MODELS.glm}` && /3 tool calls failed/.test(esc?.data?.reason ?? ""), "after 3 failed tool calls it climbed to GLM-5.3", JSON.stringify(esc?.data ?? null));
    ok(code.status === "completed" && calls.some((c) => c.model === MODELS.glm && /Refactor utils/.test(c.user)), "…which finished the task", code.status);
    ok(!calls.some((c) => c.model === MODELS.sol), "GPT-5.6 Sol was never used");
    const cc = lastCredits(code.events);
    ok(cc && cc.credits > 0 && cc.budget === 4000, `the run was metered (${cc?.credits} of ${cc?.budget} credits)`, JSON.stringify(cc ?? null));

    console.log("\n2. A small edit starts on the cheap code helper");
    const small = await runTask("Fix the typo in notes.txt");
    ok(started(small.events).actualModelId === `mistral:${MODELS.codestral}` && small.status === "completed", "Codestral fixed it", `${started(small.events).actualModelId} ${small.status}`);

    console.log("\n3. Server agent");
    const srv = await runTask("Why is nginx returning 502 on the VPS?");
    ok(started(srv.events).route?.profile === "server" && started(srv.events).actualModelId === `gemini:${MODELS.gemini}`, "a server question starts on Gemini 3.8 Flash", `${started(srv.events).route?.profile} ${started(srv.events).actualModelId}`);

    console.log("\n4. Auto");
    const auto = await runTask("Create hello.txt with the text hi");
    ok(started(auto.events).actualModelId === `openrouter:${MODELS.deepseek32}` && auto.status === "completed", "routine work uses DeepSeek V3.2 (OpenRouter)", `${started(auto.events).actualModelId} ${auto.status}`);

    console.log("\n5. Deep question in chat");
    const chat = await new Promise((resolveChat) => {
      const WebSocket = globalThis.WebSocket;
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
      let text = "";
      sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history: [], userMessage: "What should we name our foundation model family? Give me your recommendation.", context: { useRag: false } }));
      sock.onmessage = (ev) => { const c = JSON.parse(ev.data); if (c.delta) text += c.delta; if (c.done) { sock.close(); resolveChat(text); } };
      sock.onerror = () => resolveChat(text);
      setTimeout(() => resolveChat(text), 15000);
    });
    ok(/Answer from gemini-3\.8-flash/.test(String(chat)), "answered by Gemini 3.8 Flash, not GPT-5.6 Sol", String(chat));

    console.log("\n6. Credit budget");
    const big = await runTask("Create five files with long content");
    const bc = lastCredits(big.events);
    ok(big.events.some((e) => e.type === "run.credits.warning"), "at 80% of the budget ORION is told to finish the essentials");
    const err = [...big.events].reverse().find((e) => e.type === "run.error")?.data?.message ?? "";
    ok(big.status === "error" && /credit budget/.test(err), "over the budget the run stops with a clear message", `${big.status} ${err}`);
    ok(bc && bc.credits > 20, `…after ${bc?.credits} credits (budget ${bc?.budget})`);
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(failures === 0 ? "\nROUTING: PASS" : `\nROUTING: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
