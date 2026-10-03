// scripts/acceptance/stall-watchdog.mjs
//
// Nothing hangs forever: a task whose model never answers ends as a
// recoverable error (RUN_STALLED, Retry) via the progress watchdog; Cancel
// settles a hung run; a chat turn whose model never answers ends with
// "ORION stopped responding … Retry" (heartbeats keep a slow-but-alive turn open).
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/stall-watchdog.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4821, MODEL_PORT = 4822;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const fixture = join(repoRoot, "scripts", "acceptance", "fixtures", "virphone-site");
const work = mkdtempSync(join(tmpdir(), "orvyn-stall-"));
const project = (name, withCss = false) => { const dir = join(work, name); cpSync(fixture, dir, { recursive: true }); if (!withCss) cpSync(join(fixture, "index.html"), join(dir, "index.html")); return dir; };

// A new stylesheet the restyle needs (the fixture's styles.css is removed per scenario).
const CSS1 = ":root{--bg:#070b14;--ink:#e6edf7;--brand:#3b82f6}\nbody{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif}\n.header{position:sticky;top:0;background:rgba(7,11,20,.9)}\n";
const CSS2 = ".hero{padding:140px 0 90px;text-align:center;background:radial-gradient(ellipse at top,rgba(59,130,246,.25),transparent 60%)}\n.hero h1{font-size:56px;font-weight:800;letter-spacing:-.02em}\n.card{background:#0f1726;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px}\n";
const BIG = Array.from({ length: 1400 }, (_, i) => `.u-${i}{margin:${i % 48}px;color:#${(i * 2654435761 >>> 8).toString(16).padStart(6, "0").slice(0, 6)}}`).join("\n");
const seen = { modelCalls: {}, repairNotes: [] };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");

// The model accepts the request and never answers ("Scenario hang").
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  if (/Scenario hang/.test(JSON.stringify(msgs))) return { hang: true };
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    if (turn.hang) { res.writeHead(200, { "Content-Type": "text/event-stream" }); return; }
    const args = turn.call ? (turn.call.raw ?? JSON.stringify(turn.call.args)) : "";
    const id = `call_${++seq}`;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text ?? "", tool_calls: turn.call ? [{ id, type: "function", function: { name: turn.call.name, arguments: args } }] : undefined }, finish_reason: turn.finish ?? (turn.call ? "tool_calls" : "stop") }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (turn.call) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: "" } }] } }] });
      for (const piece of args.match(/[\s\S]{1,512}/g) ?? []) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (turn.call ? "tool_calls" : "stop") }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json = {}; try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
async function runTask(instruction, projectRoot) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
  const runId = started.json.runId;
  if (!runId) return { status: `start failed ${started.status}`, events: [] };
  for (let i = 0; i < 400; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    if (["completed", "error", "cancelled", "blocked", "failed"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [] };
    await sleep(250);
  }
  return { runId, status: "timeout", events: [] };
}
const of = (run, type) => run.events.filter((e) => e.type === type);
const writesRan = (run) => run.events.filter((e) => e.type === "tool.completed" && e.data?.tool === "write_file").length;

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = { ...process.env, ORVYN_DATA_DIR: join(work, "data"), PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"), MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent", ORVYN_RUN_STALL_MS: "6000", ORVYN_CHAT_STALL_MS: "5000", ORVYN_MODEL_STREAM_IDLE_MS: "5000", ORVYN_MODEL_CALL_TIMEOUT_MS: "8000" };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    console.log("\n1. A task whose model never answers → stops as a recoverable error, not endless thinking");
    const t0 = Date.now();
    const r = await runTask("Scenario hang: add a footer", project("hang"));
    const err = r.events.find((e) => e.type === "run.error")?.data;
    ok(r.status === "error" && err && /retr/i.test(String(err.message)) && !/undefined/.test(String(err.message)), "the run settled as a recoverable error with a plain message (Retry)", `${r.status} ${JSON.stringify(err)}`);
    ok(Date.now() - t0 < 60000 && !r.events.some((e) => e.type === "run.completed"), "the watchdog/timeouts ended it within a minute — no endless thinking", `${Date.now() - t0}ms`);
    const cancelRun = await api("/agent/stream/runs", "POST", { instruction: "Scenario hang: another", projectRoot: project("hang2"), executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
    await sleep(1500);
    const c = await api(`/agent/stream/runs/${cancelRun.json.runId}/cancel`, "POST", {});
    await sleep(800);
    const after = await api(`/agent/stream/runs/${cancelRun.json.runId}/events.json`);
    ok(after.json.status === "cancelled" && (after.json.events ?? []).some((e) => e.type === "run.cancelled"), "Cancel settles a hung run as cancelled", `${c.status} ${after.json.status}`);

    console.log("\n2. A chat turn whose model never answers → ends with a plain error (heartbeats meanwhile)");
    const chunks = await new Promise((resolveChat) => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
      const got = [];
      sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history: [], userMessage: "Scenario hang chat", context: { useRag: false } }));
      sock.onmessage = (ev) => { const m = JSON.parse(ev.data); got.push(m); if (m.done) { sock.close(); resolveChat(got); } };
      setTimeout(() => resolveChat(got), 30000);
    });
    const last = chunks[chunks.length - 1];
    ok(last?.done === true && /stopped responding/.test(String(last.error)), "the turn ended: “ORION stopped responding … Retry”", JSON.stringify(last));
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-3000));
  console.log(failures === 0 ? "\nSTALL WATCHDOG: PASS" : `\nSTALL WATCHDOG: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
