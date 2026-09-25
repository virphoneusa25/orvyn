// scripts/acceptance/phase3-execution-target.mjs
//
// PHASE 3 acceptance — Workspace + execution target.
//
// Recreates the production topology on one machine:
//   * the backend runs as the OVH control plane (ORVYN_CLOUD_MODE=true,
//     ORVYN_PROJECTS_DIR set),
//   * a Local Worker speaks the real /local-worker protocol and executes tools
//     with the real LocalToolExecutor, but only inside a "laptop" folder that
//     the desktop knows by a Windows path (C:\Users\tester\fixture),
//   * a scripted OpenAI-compatible model stands in for the provider.
//
// TEST A  local project open  → "Create local-test.txt" lands in the laptop
//         folder and nowhere on the control plane.
// TEST C  local project, Local Worker offline → refused with a clear reason,
//         never silently moved to the Cloud workspace.
// TEST B  no project          → "Create cloud-test.txt in a cloud workspace"
//         lands in the cloud workspace only, never on the laptop and never
//         under a Windows-looking path on the server.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/phase3-execution-target.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4621, MODEL_PORT = 4622;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "phase2-test-key-000000000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const require = createRequire(import.meta.url);
const { executeLocalTool } = require(join(repoRoot, "apps", "backend", "dist", "localWorker", "LocalToolExecutor.js"));

const WIN_ROOT = "C:\\Users\\tester\\fixture";
const laptopDir = mkdtempSync(join(tmpdir(), "orvyn-p2-laptop-"));
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-p2-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-p2-cloudprojects-"));
const backendCwd = join(repoRoot, "apps", "backend");

// ---- scripted model -------------------------------------------------------
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const user = [...msgs].reverse().find((m) => m.role === "user" && !String(m.content).startsWith("["))?.content ?? "";
  const name = (String(user).match(/([\w.-]+\.txt)/) ?? [])[1] ?? "out.txt";
  const wrote = msgs.some((m) => m.role === "tool");
  if (!wrote && tools.includes("write_file")) {
    return { text: `Creating ${name}.`, call: { name: "write_file", args: { path: name, content: `written by ORION: ${name}` } } };
  }
  return { text: `Done. Created ${name}.` };
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

// ---- control plane helpers -----------------------------------------------
const H = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};

// ---- fake desktop Local Worker (real protocol, real executor) -------------
const workerLog = [];
let workerStop = false;
async function localWorker() {
  const workerId = "local_TESTLAPTOP_1";
  await api("/local-worker/register", "POST", { workerId, hostname: "TESTLAPTOP", projectRoot: WIN_ROOT, capabilities: ["local_host"], environment: {} });
  const hb = setInterval(() => void api("/local-worker/heartbeat", "POST", { workerId, projectRoot: WIN_ROOT }), 5000);
  while (!workerStop) {
    const { json } = await api("/local-worker/poll").catch(() => ({ json: {} }));
    if (json.job) void serve(json.job);
    await new Promise((r) => setTimeout(r, 300));
  }
  clearInterval(hb);
}
function toLaptop(p) {
  // The laptop only knows its Windows path; map it (and nothing else) to the temp folder.
  const s = String(p ?? "");
  if (s.replace(/\//g, "\\").toLowerCase().startsWith(WIN_ROOT.toLowerCase())) return laptopDir + s.slice(WIN_ROOT.length).replace(/\\/g, "/");
  return null;
}
async function serve(job) {
  const root = toLaptop(job.projectRoot);
  workerLog.push({ runId: job.runId, projectRoot: job.projectRoot, mapped: root });
  if (!root) {
    await api(`/local-worker/events/${job.runId}`, "POST", { type: "sandbox.stopped", data: { reason: `laptop does not have ${job.projectRoot}` } });
    return;
  }
  await api(`/local-worker/events/${job.runId}`, "POST", { type: "sandbox.ready", data: { projectRoot: job.projectRoot, role: "local_host", workerId: "local_TESTLAPTOP_1" } });
  while (true) {
    const { json: next } = await api(`/local-worker/tools/${job.runId}/next`);
    if (next.finished) return;
    if (!next.request) { await new Promise((r) => setTimeout(r, 150)); continue; }
    const q = next.request;
    workerLog.push({ runId: job.runId, tool: q.tool, args: q.arguments });
    const result = await executeLocalTool({ tool: q.tool, arguments: q.arguments ?? {}, runId: job.runId, projectRoot: root, onOutput: () => {} });
    await api(`/local-worker/tools/${job.runId}/result`, "POST", { requestId: q.requestId, runId: job.runId, ok: result.ok, output: result.output, error: result.error, durationMs: 1 });
  }
}

// ---- run + inspect ---------------------------------------------------------
async function run(instruction, projectRoot) {
  const payload = { projectRoot, remoteProjectRoot: projectRoot ?? "/opt/orvyn/workspaces", executionTarget: "auto", composerMode: "auto", instruction, mode: "agent", permissionMode: "full_access" };
  const started = await api("/agent/stream/runs", "POST", payload);
  if (!started.json.runId) return { refused: started };
  const runId = started.json.runId;
  let after = 0, status = "running"; const events = [];
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const { json } = await api(`/agent/stream/runs/${runId}/events.json?after=${after}`);
    for (const e of json.events ?? []) { events.push(e); after = Math.max(after, Number(e.sequence ?? after)); }
    status = json.status;
    if (!["running", "queued", "awaiting_approval", "verifying"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return { runId, status, events, started: started.json };
}

function find(dir, name, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) find(p, name, out);
    else if (e === name || e.endsWith(`\\${name}`)) out.push(p);
  }
  return out;
}
function windowsNamedPaths(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".git") continue;
    const p = join(dir, e);
    if (/^[A-Za-z]:|\\/.test(e)) out.push(p);
    try { if (statSync(p).isDirectory()) windowsNamedPaths(p, out); } catch {}
  }
  return out;
}

let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; };
const exec = (events) => events.filter((e) => e.type === "run.execution").pop()?.data ?? {};
const tail = (events) => events.filter((e) => /error|blocked|stopped/.test(e.type)).map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 200)}`).join(" | ");

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
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
    console.log(`\nTEST C — local project open but the Local Worker is offline`);
    const c = await run("Create offline-test.txt", WIN_ROOT);
    ok(Boolean(c.refused) && c.refused.status === 409, "the run is refused instead of silently moving to Cloud", JSON.stringify(c.refused ?? { status: c.status, exec: exec(c.events ?? []) }));
    ok(/Local Worker/i.test(String(c.refused?.json?.error ?? "")), "the refusal names the Local Worker", String(c.refused?.json?.error ?? ""));
    const offlineCopies = [...find(projectsDir, "offline-test.txt"), ...find(dataDir, "offline-test.txt"), ...find(laptopDir, "offline-test.txt")];
    ok(offlineCopies.length === 0, "no file was written anywhere", offlineCopies.join(", "));

    void localWorker();
    await new Promise((r) => setTimeout(r, 1200));

    console.log(`\nTEST A — local project open (${WIN_ROOT})`);
    const a = await run("Create local-test.txt", WIN_ROOT);
    if (a.refused) ok(false, "run starts", JSON.stringify(a.refused));
    else {
      const x = exec(a.events);
      console.log(`        execution: ${JSON.stringify({ requested: x.executionTargetRequested, actual: x.executionTargetActual, location: x.location, label: x.executionLabel, reason: x.fallbackReason })}`);
      ok(a.status === "completed", "run completes", `status=${a.status} ${tail(a.events)}`);
      ok(x.executionTargetActual === "local_host" && x.executionLabel === "Local", "the run says Local / local_host", JSON.stringify(x));
      const pre = a.events.filter((e) => e.type === "preflight.completed").pop()?.data ?? {};
      ok(pre.executionTarget === "local_host", "preflight agrees: local_host", JSON.stringify(pre));
      ok(workerLog.some((w) => w.runId === a.runId && w.tool === "write_file"), "the laptop's Local Worker executed write_file", JSON.stringify(workerLog.filter((w) => w.runId === a.runId)));
      ok(existsSync(join(laptopDir, "local-test.txt")), "local-test.txt exists in the laptop project folder");
      const stray = [...find(projectsDir, "local-test.txt"), ...find(dataDir, "local-test.txt"), ...find(backendCwd, "local-test.txt")];
      ok(stray.length === 0, "no copy on the control plane", stray.join(", "));
    }

    console.log(`\nTEST B — no project, cloud workspace`);
    const b = await run("Create cloud-test.txt in a cloud workspace", undefined);
    if (b.refused) ok(false, "run starts", JSON.stringify(b.refused));
    else {
      const x = exec(b.events);
      console.log(`        execution: ${JSON.stringify({ requested: x.executionTargetRequested, actual: x.executionTargetActual, location: x.location, label: x.executionLabel, root: x.remoteProjectRoot })}`);
      ok(b.status === "completed", "run completes", `status=${b.status} ${tail(b.events)}`);
      const cloud = [...find(projectsDir, "cloud-test.txt"), ...find(dataDir, "cloud-test.txt")];
      ok(cloud.length === 1, "cloud-test.txt exists exactly once in the cloud workspace", cloud.join(", ") || "(not found)");
      ok(!existsSync(join(laptopDir, "cloud-test.txt")), "nothing written to the laptop folder");
      ok(!workerLog.some((w) => w.runId === b.runId), "the Local Worker was not used");
      ok(x.executionLabel === "Cloud" && x.executionTargetActual === "cloud_control_plane", "the run says Cloud (never Local)", JSON.stringify(x));
    }

    const winPaths = [...windowsNamedPaths(projectsDir), ...windowsNamedPaths(dataDir), ...windowsNamedPaths(backendCwd)];
    ok(winPaths.length === 0, "the control plane never created a Windows-named path", winPaths.slice(0, 5).join(", "));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.message); console.error(log.join("").slice(-2500));
  } finally {
    workerStop = true; server.kill(); model.close();
  }
  console.log(failures === 0 ? "\nPHASE 3: PASS" : `\nPHASE 3: FAIL (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
