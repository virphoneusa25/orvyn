// scripts/acceptance/phase4-services.mjs
//
// PHASE 4 acceptance — services persist.
//
// One run creates a real Vite app, installs it and starts the dev server.
// The run finishes. Three minutes later the dev server must still answer,
// ORVYN must still list it as running, and Stop must take it down.
//
// Topology, all real code on one machine:
//   * the backend as the ORVYN Cloud control plane (cloud mode),
//   * the REAL desktop Local Worker process (dist/localWorker/entry.js),
//     serving a project the desktop names by a Windows path,
//   * a scripted OpenAI-compatible model that picks the steps.
//
// LOCAL  a project open on the laptop (Local) → the worker runs npm install and
//        npm run dev on "the laptop"; the service outlives the run.
// CLOUD  no project, "in a cloud workspace" → the same app in the ORVYN
//        Cloud workspace on the control plane; the service outlives the run.
//
// Needs network for `npm install vite`.
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/phase4-services.mjs            (waits 3 minutes)
//   WAIT_MS=20000 node scripts/acceptance/phase4-services.mjs   (quick check)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4651, MODEL_PORT = 4652;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "phase4-test-key-000000000000000000000000";
const WAIT_MS = Number(process.env.WAIT_MS) || 3 * 60_000;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");

// "The laptop": a real folder the real Local Worker serves. The run names it
// with executionTarget "local_host" (the Local chip), so the control plane
// hands it to the worker untouched. Phase 3 covers how Auto picks Local for
// a Windows path; here the question is only what happens to the service.
const laptopHome = mkdtempSync(join(tmpdir(), "orvyn-p4-laptop-"));
const WIN_ROOT = join(laptopHome, "vite-app");
const laptopProject = WIN_ROOT;
mkdirSync(laptopProject, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-p4-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-p4-cloudprojects-"));

// ---- the Vite app the model writes ----------------------------------------
const PKG = JSON.stringify({ name: "vite-app", private: true, type: "module", scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "^6.0.0" } }, null, 2) + "\n";
const HTML = `<!doctype html>\n<html lang="en">\n  <head><meta charset="UTF-8" /><title>Phase 4</title></head>\n  <body>\n    <div id="app"></div>\n    <script type="module" src="/main.js"></script>\n  </body>\n</html>\n`;
const MAIN = `document.querySelector("#app").textContent = "ORVYN phase 4 service";\n`;

// ---- scripted model --------------------------------------------------------
const modelLog = [];
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
  const wrote = (p) => results.some((r) => r.name === "write_file" && r.args.path === p);
  const ran = (re) => results.find((r) => r.name === "terminal" && re.test(String(r.args.command ?? "")));
  modelLog.push({ tools: tools.length, results: results.map((r) => `${r.name}:${String(r.args.command ?? r.args.path ?? "")}`) });
  if (!wrote("package.json")) return { text: "I'll create a small Vite app, install it, and start the dev server.", call: { name: "write_file", args: { path: "package.json", content: PKG } } };
  if (!wrote("index.html")) return { text: "", call: { name: "write_file", args: { path: "index.html", content: HTML } } };
  if (!wrote("main.js")) return { text: "", call: { name: "write_file", args: { path: "main.js", content: MAIN } } };
  if (!ran(/npm install/)) return { text: "Installing dependencies.", call: { name: "terminal", args: { command: "npm install --no-audit --no-fund" } } };
  const dev = ran(/npm run dev/);
  if (!dev) return { text: "Starting the dev server.", call: { name: "terminal", args: { command: "npm run dev" } } };
  const url = (dev.content.match(/https?:\/\/localhost:\d+\/?/) ?? [])[0];
  return { text: url ? `Done. The Vite dev server is running at ${url} and keeps running after this run.` : `The dev server did not report a URL: ${dev.content.slice(0, 300)}` };
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

async function run(instruction, projectRoot, target = "auto") {
  const payload = { projectRoot, remoteProjectRoot: projectRoot ?? "/opt/orvyn/workspaces", executionTarget: target, composerMode: "auto", instruction, mode: "agent", permissionMode: "full_access" };
  const started = await api("/agent/stream/runs", "POST", payload);
  if (!started.json.runId) return { refused: started };
  const runId = started.json.runId;
  let after = 0, status = "running"; const events = [];
  const deadline = Date.now() + 300_000;
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
const exec = (events) => events.filter((e) => e.type === "run.execution").pop()?.data ?? {};
const tail = (events) => events.filter((e) => /error|blocked|failed|stopped/.test(e.type)).map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 240)}`).join(" | ");
const services = async () => (await api("/services")).json.services ?? [];

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
      env: { ...process.env, ORVYN_CONTROL_PLANE: BASE, ORVYN_API_KEY: API_KEY, ORVYN_PROJECT_ROOT: WIN_ROOT, ORVYN_LOCAL_WORKER: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (d) => workerLog.push(String(d)));
    worker.stderr.on("data", (d) => workerLog.push(String(d)));
    for (let i = 0; i < 40 && !workerLog.join("").includes("registered"); i++) await new Promise((r) => setTimeout(r, 250));

    // ── LOCAL ──────────────────────────────────────────────────────────────
    console.log(`\nLOCAL — project open on "the laptop", the Local Worker runs the app`);
    const a = await run("Create a small Vite app, install it, and start the dev server.", WIN_ROOT, "local_host");
    let localSvc;
    if (a.refused) ok(false, "run starts", JSON.stringify(a.refused));
    else {
      const x = exec(a.events);
      ok(x.executionLabel === "Local", "the run says Local", JSON.stringify(x));
      ok(a.status === "completed", "the run finishes", `status=${a.status} ${tail(a.events)}`);
      ok(existsSync(join(laptopProject, "node_modules", "vite")), "npm install ran in the laptop project");
      const devDone = a.events.find((e) => e.type === "tool.completed" && /http:\/\/localhost:\d+/.test(JSON.stringify(e.data)));
      ok(Boolean(devDone), "npm run dev returned with the URL (it did not hang the run)", tail(a.events));
      const preview = a.events.find((e) => e.type === "preview.available" && /^http:\/\/localhost:\d+/.test(String(e.data?.url)));
      ok(Boolean(preview?.data?.serviceId), "the chat got the service's local URL", JSON.stringify(a.events.filter((e) => e.type === "preview.available").map((e) => e.data)));
      await new Promise((r) => setTimeout(r, 1500));
      localSvc = (await services()).find((s) => s.location === "local" && s.status === "running");
      ok(Boolean(localSvc?.url), "ORVYN lists the Local service as running after the run ended", JSON.stringify(await services()));
      ok(/finished; 1 service\(s\) keep running/.test(workerLog.join("")), "the worker kept the service when the run finished", workerLog.join("").slice(-600));
    }

    // ── CLOUD ──────────────────────────────────────────────────────────────
    console.log(`\nCLOUD — no project, "in a cloud workspace"`);
    const b = await run("Create a small Vite app in a cloud workspace, install it, and start the dev server.", undefined);
    let cloudSvc;
    if (b.refused) ok(false, "run starts", JSON.stringify(b.refused));
    else {
      const x = exec(b.events);
      ok(x.executionLabel === "Cloud", "the run says Cloud", JSON.stringify(x));
      ok(b.status === "completed", "the run finishes", `status=${b.status} ${tail(b.events)}`);
      const inCloud = findFile(projectsDir, "main.js").concat(findFile(dataDir, "main.js"));
      ok(inCloud.length === 1, "the app is in the ORVYN Cloud workspace", inCloud.join(", ") || "(not found)");
      cloudSvc = (await services()).find((s) => s.location === "cloud" && s.status === "running");
      ok(Boolean(cloudSvc?.url), "ORVYN lists the Cloud service as running after the run ended", JSON.stringify(await services()));
      ok(!b.events.some((e) => e.type === "preview.available" && /localhost/.test(String(e.data?.url))), "a Cloud localhost is never handed to the desktop browser");
    }

    // ── three minutes later ───────────────────────────────────────────────
    console.log(`\nWaiting ${Math.round(WAIT_MS / 1000)}s with no run active…`);
    await new Promise((r) => setTimeout(r, WAIT_MS));
    for (const [label, svc] of [["Local", localSvc], ["Cloud", cloudSvc]]) {
      if (!svc) { ok(false, `${label}: service to check`); continue; }
      const page = await httpGet(svc.url);
      ok(page.status === 200 && /@vite\/client/.test(page.body), `${label}: ${svc.url} still serves the Vite app`, `status=${page.status} ${page.body.slice(0, 120)}`);
      const now = (await services()).find((s) => s.serviceId === svc.serviceId);
      ok(now?.status === "running", `${label}: ORVYN still reports it running`, JSON.stringify(now ?? null));
    }

    // ── Stop ───────────────────────────────────────────────────────────────
    console.log(`\nStop from ORVYN`);
    for (const [label, svc] of [["Local", localSvc], ["Cloud", cloudSvc]]) {
      if (!svc) continue;
      const r = await api(`/services/${encodeURIComponent(svc.serviceId)}/stop`, "POST");
      ok(r.status === 200, `${label}: Stop accepted`, JSON.stringify(r));
      let down = false;
      for (let i = 0; i < 40 && !down; i++) { await new Promise((r) => setTimeout(r, 250)); down = (await httpGet(svc.url)).status === 0; }
      ok(down, `${label}: the dev server is down after Stop`);
    }
    await new Promise((r) => setTimeout(r, 2500));
    ok((await services()).filter((s) => s.status === "running").length === 0, "nothing is listed as running after Stop", JSON.stringify(await services()));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message); console.error(log.join("").slice(-2500));
  } finally {
    worker?.kill("SIGTERM"); server.kill(); model.close();
  }
  if (failures) {
    console.log("\n--- worker log (tail) ---\n" + workerLog.join("").slice(-1500));
    console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  }
  console.log(failures === 0 ? "\nPHASE 4: PASS" : `\nPHASE 4: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
}
main();
