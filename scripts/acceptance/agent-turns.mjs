// scripts/acceptance/agent-turns.mjs
//
// AgentTurn acceptance. ONE user message:
//
//   "Create a.js, create b.js, run them, and tell me the output."
//
// must drive several model turns inside one run —
//   model → write_file a.js → model → write_file b.js → model → node a.js
//   → model → node b.js → model → final answer
// — and end with the completion evaluator approving a final answer that
// reports the REAL output of both programs (taken from the tool results).
//
// The scripted model decides each step from the conversation it is sent,
// like a real model: it never sees anything but tool results.
// Checked on Local (the real desktop Local Worker) and Cloud.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/agent-turns.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROMPT = "Create a.js, create b.js, run them, and tell me the output.";
const PORT = 4671, MODEL_PORT = 4672;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "agentturn-test-key-0000000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const laptopHome = mkdtempSync(join(tmpdir(), "orvyn-turns-laptop-"));
const LOCAL_ROOT = join(laptopHome, "project");
mkdirSync(LOCAL_ROOT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-turns-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-turns-cloudprojects-"));

const A_JS = "console.log(\"a.js:\", 6 * 7);\n";
const B_JS = "console.log(\"b.js:\", [1, 2, 3].map((x) => x * 2).join(\",\"));\n";

// Scripted model: one step per turn, chosen from the tool results so far.
const modelCalls = [];
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const results = msgs.filter((m) => m.role === "tool").map((m) => {
    const call = asked.find((c) => c.id === m.tool_call_id);
    let args = {}; try { args = JSON.parse(call?.function?.arguments ?? "{}"); } catch {}
    return { name: call?.function?.name, args, content: String(m.content ?? "") };
  });
  modelCalls.push(results.length);
  const wrote = (p) => results.some((r) => r.name === "write_file" && r.args.path === p && !/FAILED/.test(r.content));
  const ran = (file) => results.find((r) => r.name === "terminal" && String(r.args.command) === `node ${file}`);
  if (!wrote("a.js")) return { text: "I'll create a.js first.", call: { name: "write_file", args: { path: "a.js", content: A_JS } } };
  if (!wrote("b.js")) return { text: "Now b.js.", call: { name: "write_file", args: { path: "b.js", content: B_JS } } };
  if (!ran("a.js")) return { text: "Both files exist. Running a.js.", call: { name: "terminal", args: { command: "node a.js" } } };
  if (!ran("b.js")) return { text: "Running b.js.", call: { name: "terminal", args: { command: "node b.js" } } };
  const out = (file) => ran(file).content.trim().split(/\r?\n/).filter(Boolean).pop() ?? "(no output)";
  return { text: `Done. I created a.js and b.js and ran both.\n\nnode a.js printed: ${out("a.js")}\nnode b.js printed: ${out("b.js")}` };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
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

// ---- control plane helpers -------------------------------------------------
const H = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};

async function run(instruction, projectRoot, target = "auto", previousRunId) {
  const payload = { previousRunId, projectRoot, remoteProjectRoot: projectRoot ?? "/opt/orvyn/workspaces", executionTarget: target, composerMode: "auto", instruction, mode: "agent", permissionMode: "full_access" };
  const started = await api("/agent/stream/runs", "POST", payload);
  if (!started.json.runId) return { refused: started };
  const runId = started.json.runId;
  let after = 0, status = "running"; const events = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { json } = await api(`/agent/stream/runs/${runId}/events.json?after=${after}`);
    for (const e of json.events ?? []) { events.push(e); after = Math.max(after, Number(e.sequence ?? after)); }
    status = json.status;
    if (!["running", "queued", "awaiting_approval", "verifying"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { runId, status, events, started: started.json };
}

async function httpGet(url) {
  // Vite binds "localhost", which may be ::1 only; try both loopbacks.
  const u = new URL(url);
  for (const host of ["127.0.0.1", "[::1]"]) {
    try {
      const r = await fetch(`http://${host}:${u.port}/`, { signal: AbortSignal.timeout(4000) });
      return { status: r.status, body: await r.text() };
    } catch { /* next */ }
  }
  return { status: 0, body: "" };
}

function findFile(dir, name, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules") continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) findFile(p, name, out); else if (e === name) out.push(p);
  }
  return out;
}

let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; };
const tail = (events) => events.filter((e) => /error|blocked|failed/.test(e.type)).map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 240)}`).join(" | ");

function finalText(events) {
  const grounded = events.filter((e) => e.type === "message.grounded").pop();
  if (grounded) return String(grounded.data.content ?? "");
  let text = "";
  for (const e of events) {
    if (e.type === "tool.started" || e.type === "tool.completed") text = "";
    if (e.type === "message.delta") text += String(e.data.content ?? "");
  }
  return text;
}

async function scenario(label, root, target, dir) {
  const before = modelCalls.length;
  const r = await run(PROMPT, root, target);
  if (r.refused) { ok(false, `${label}: run starts`, JSON.stringify(r.refused)); return; }
  ok(r.status === "completed", `${label}: the run completes`, `status=${r.status} ${tail(r.events)}`);
  const turns = r.events.filter((e) => e.type === "agent.turn").map((e) => e.data);
  const summary = turns.map((t) => `${t.turn}:${t.kind}${t.tools.length ? `(${t.tools.join(",")})` : ""}`).join(" → ");
  console.log(`        turns: ${summary}`);
  const toolTurns = turns.filter((t) => t.kind === "tools");
  ok(toolTurns.length >= 4, `${label}: one user message drove ${toolTurns.length} model→tool turns`, summary);
  ok(turns.at(-1)?.kind === "final", `${label}: the last turn is a final answer`, summary);
  const modelTurns = modelCalls.length - before;
  ok(modelTurns >= 5, `${label}: the model was called ${modelTurns} times in this one run`, String(modelTurns));
  const userTurns = r.events.filter((e) => e.type === "run.started").length;
  ok(userTurns === 1, `${label}: all of it happened in one run started by one message`, `run.started × ${userTurns}`);
  const done = r.events.find((e) => e.type === "agent.loop.finished")?.data;
  ok(done?.outcome === "completed" && /evaluator approved/.test(done?.reason ?? ""), `${label}: the completion evaluator approved completion`, JSON.stringify(done));
  const cmds = r.events.filter((e) => e.type === "tool.completed" && e.data.tool === "terminal").map((e) => e.data.envelope);
  ok(cmds.length === 2 && cmds.every((c) => c?.structuredData?.exitCode === 0), `${label}: node a.js and node b.js both ran (exit 0)`, JSON.stringify(cmds.map((c) => c?.userSummary)));
  const text = finalText(r.events);
  ok(/a\.js: 42/.test(text) && /b\.js: 2,4,6/.test(text), `${label}: the final answer reports the real output of both`, text.slice(0, 300));
  console.log(`        final: ${text.replace(/\n+/g, " | ").slice(0, 160)}`);
  if (dir) ok(existsSync(join(dir, "a.js")) && existsSync(join(dir, "b.js")), `${label}: a.js and b.js are in the project`);
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: projectsDir, ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_API_KEY: API_KEY, ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let worker;
  const workerLog = [];
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
    worker = spawn(process.execPath, [join(backendCwd, "dist", "localWorker", "entry.js")], {
      cwd: laptopHome,
      env: { ...process.env, ORVYN_CONTROL_PLANE: BASE, ORVYN_API_KEY: API_KEY, ORVYN_PROJECT_ROOT: LOCAL_ROOT, ORVYN_LOCAL_WORKER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (d) => workerLog.push(String(d)));
    worker.stderr.on("data", (d) => workerLog.push(String(d)));
    for (let i = 0; i < 40 && !workerLog.join("").includes("registered"); i++) await new Promise((r) => setTimeout(r, 250));

    console.log(`\nLOCAL — "${PROMPT}"`);
    await scenario("Local", LOCAL_ROOT, "local_host", LOCAL_ROOT);
    console.log(`\nCLOUD — "${PROMPT}" (cloud workspace)`);
    await scenario("Cloud", undefined, "auto");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
  } finally {
    worker?.kill("SIGTERM"); server.kill(); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500) + "\n--- worker ---\n" + workerLog.join("").slice(-800));
  console.log(failures === 0 ? "\nAGENT TURNS: PASS" : `\nAGENT TURNS: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
