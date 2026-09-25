// scripts/acceptance/envelope-hello.mjs
//
// ToolResultEnvelope acceptance. Through the real runtime, ToolGateway and
// run events:
//
//   "Create hello.txt"  → the tool event carries evidence
//                         { type: file, operation: write, file: hello.txt }
//   "Now read it"       → the tool event carries evidence
//                         { type: file, operation: read, file: hello.txt }
//
// and every tool event has toolName, status, modelPayload (size on the
// event), userSummary, structuredData, evidence, retryable. The read's
// sha256 equals the write's: the file read back is the file written.
//
// Checked on both paths: Local (the real desktop Local Worker process) and
// Cloud (a cloud workspace on the control plane).
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/envelope-hello.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4661, MODEL_PORT = 4662;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "envelope-test-key-00000000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const laptopHome = mkdtempSync(join(tmpdir(), "orvyn-env-laptop-"));
const LOCAL_ROOT = join(laptopHome, "project");
mkdirSync(LOCAL_ROOT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-env-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-env-cloudprojects-"));
const CONTENT = "Hello from ORION\n";

// Scripted model: write hello.txt when asked to create it, read it when asked to read it.
function nextTurn(body) {
  // The independent verifier (VerificationRuntime) asks the same model; this stand-in approves and lets the automatic read-only checks decide.
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const user = String([...msgs].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("["))?.content ?? "");
  const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
  const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant" && m.tool_calls?.length);
  const sinceUser = msgs.slice(msgs.lastIndexOf([...msgs].reverse().find((m) => m.role === "user"))).some((m) => m.role === "tool");
  if (/read/i.test(user)) {
    if (!sinceUser) return { text: "Reading hello.txt.", call: { name: "read_file", args: { path: "hello.txt" } } };
    return { text: `hello.txt says: ${String(lastTool?.content ?? "").trim()}` };
  }
  if (!sinceUser) return { text: "Creating hello.txt.", call: { name: "write_file", args: { path: "hello.txt", content: CONTENT } } };
  void lastAssistant;
  return { text: "Done. Created hello.txt." };
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
const KEYS = ["toolName", "status", "userSummary", "structuredData", "evidence", "retryable", "modelPayloadBytes"];

function checkEnvelope(label, events, tool, operation) {
  const done = events.filter((e) => (e.type === "tool.completed" || e.type === "tool.failed") && e.data?.tool === tool);
  ok(done.length === 1, `${label}: one ${tool} tool event`, JSON.stringify(done.map((e) => e.type)) + " " + tail(events));
  const ev = done[0];
  const env = ev?.data?.envelope;
  ok(Boolean(env), `${label}: the ${tool} event carries an envelope`, JSON.stringify(ev?.data ?? null).slice(0, 400));
  if (!env) return null;
  const missing = KEYS.filter((k) => !(k in env));
  ok(missing.length === 0, `${label}: envelope has toolName, status, modelPayload, userSummary, structuredData, evidence, retryable`, `missing ${missing.join(", ")}`);
  ok(env.toolName === tool && env.status === "success" && env.retryable === false, `${label}: ${tool} · success · not retryable`, JSON.stringify({ toolName: env.toolName, status: env.status, retryable: env.retryable }));
  ok(env.toolUseId === ev.data.callId, `${label}: envelope ties to the model's call id`, `${env.toolUseId} vs ${ev.data.callId}`);
  const fileEv = (env.evidence ?? []).find((e) => e.type === "file");
  ok(fileEv?.operation === operation && fileEv?.file === "hello.txt", `${label}: evidence says operation: ${operation}, file: hello.txt`, JSON.stringify(env.evidence));
  console.log(`        ${env.userSummary}   evidence=${JSON.stringify(env.evidence)}`);
  return env;
}

async function scenario(label, root, target) {
  const a = await run("Create hello.txt", root, target);
  if (a.refused) { ok(false, `${label}: run starts`, JSON.stringify(a.refused)); return; }
  ok(a.status === "completed", `${label}: "Create hello.txt" completes`, `status=${a.status} ${tail(a.events)}`);
  const w = checkEnvelope(label, a.events, "write_file", "write");
  const b = await run("Now read hello.txt", root, target, a.runId);
  if (b.refused) { ok(false, `${label}: read run starts`, JSON.stringify(b.refused)); return; }
  ok(b.status === "completed", `${label}: "Now read hello.txt" completes`, `status=${b.status} ${tail(b.events)}`);
  const r = checkEnvelope(label, b.events, "read_file", "read");
  if (w && r) ok(r.structuredData?.sha256 && r.structuredData.sha256 === w.structuredData?.sha256, `${label}: the read's sha256 matches the write's`, `${w.structuredData?.sha256} / ${r.structuredData?.sha256}`);
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

    console.log("\nLOCAL — the desktop Local Worker writes and reads on \"the laptop\"");
    await scenario("Local", LOCAL_ROOT, "local_host");
    let onDisk = ""; try { onDisk = readFileSync(join(LOCAL_ROOT, "hello.txt"), "utf8"); } catch {}
    ok(onDisk === CONTENT, "Local: hello.txt is on the laptop with the written content", JSON.stringify(onDisk));

    console.log("\nCLOUD — a cloud workspace on the control plane");
    await scenario("Cloud", undefined, "auto");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
  } finally {
    worker?.kill("SIGTERM"); server.kill(); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500) + "\n--- worker ---\n" + workerLog.join("").slice(-800));
  console.log(failures === 0 ? "\nENVELOPE: PASS" : `\nENVELOPE: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
