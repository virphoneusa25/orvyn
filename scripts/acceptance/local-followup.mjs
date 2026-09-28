// scripts/acceptance/local-followup.mjs
//
// ORVYN Cloud + the desktop's Local Worker, the way the user works (Sep 28):
//   1. "Build a simple VirPhone website" with a folder on the user's computer:
//      the files are written there by the Local Worker.
//   2. "Can you add a animated hero background?" in the same chat (the desktop
//      sends the chat's bound workspace, not the folder): the follow-up must
//      run on the user's computer again, read the files it built, open the
//      preview of the site at the start, and change the stylesheet there.
//      Before the fix it ran in an empty Cloud copy: every read was ENOENT.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/local-followup.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4781, MODEL_PORT = 4782;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "local-followup-key-0000000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-lf-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-lf-projects-"));
// "The user's computer": the worker runs here; the desktop names a Windows folder.
const computer = mkdtempSync(join(tmpdir(), "orvyn-lf-computer-"));
const DESKTOP_FOLDER = "C:\\Users\\royce\\ORVYN\\virphone";

const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>VirPhone</title><link rel="stylesheet" href="styles.css"></head><body><section class="hero"><h1>Wholesale VoIP Carrier You Can Trust</h1></section><script src="script.js"></script></body></html>';
const CSS = ".hero{min-height:60vh;background:#0b1220;color:#fff}";
const JS = "document.documentElement.dataset.ready='1';";
const ANIMATED = CSS + "\n.hero{background:linear-gradient(120deg,#0b1220,#1d4ed8,#0b1220);background-size:300% 300%;animation:heroShift 12s ease infinite}@keyframes heroShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}";
const seen = { followRead: "" };

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const user = String([...msgs].reverse().find((m) => m.role === "user" && !/^(Budget note|\[)/.test(String(m.content)))?.content ?? "");
  if (system.includes("ORVYN VERIFIER")) {
    const url = (system.match(/Published page: (\S+)/) ?? [])[1];
    const results = msgs.filter((m) => m.role === "tool");
    if (url && results.length === 0) return { text: "", call: { name: "browser_open", args: { url } } };
    if (url && results.length === 1) return { text: "", call: { name: "browser_console_errors", args: {} } };
    return { text: "VERDICT: PASS\n- The page loads its stylesheet and script." };
  }
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const results = msgs.filter((m) => m.role === "tool");
  if (/Build a simple VirPhone website/.test(user)) {
    if (results.length === 0) return { text: "Writing the page.", call: { name: "write_file", args: { path: "index.html", content: HTML } } };
    if (results.length === 1) return { text: "Styles.", call: { name: "write_file", args: { path: "styles.css", content: CSS } } };
    if (results.length === 2) return { text: "Script.", call: { name: "write_file", args: { path: "script.js", content: JS } } };
    return { text: "Built the VirPhone site." };
  }
  if (/animated hero background/i.test(user)) {
    const i = msgs.map((m) => m.role).lastIndexOf("user");
    const since = msgs.slice(i).filter((m) => m.role === "tool");
    if (since.length === 0) return { text: "Reading the stylesheet.", call: { name: "read_file", args: { path: "styles.css" } } };
    if (since.length === 1) {
      seen.followRead = String(since[0]?.content ?? "");
      return { text: "Adding the animation.", call: { name: "write_file", args: { path: "styles.css", content: ANIMATED } } };
    }
    return { text: "The hero now has an animated gradient background." };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const H = { "Content-Type": "application/json", "x-api-key": KEY, Authorization: `Bearer ${KEY}` };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function runTask(instruction, extra = {}) {
  const started = await api("/agent/stream/runs", "POST", { instruction, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access", ...extra });
  const runId = started.json.runId;
  if (!runId) return { runId, status: `start failed ${started.status}: ${JSON.stringify(started.json).slice(0, 300)}`, events: [] };
  for (let i = 0; i < 400; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    if (["completed", "error", "cancelled", "blocked"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [], sessionId: started.json.sessionId };
    await sleep(250);
  }
  return { runId, status: "timeout", events: [], sessionId: started.json.sessionId };
}

function findFile(dir, name, depth = 0) {
  if (depth > 8 || !existsSync(dir)) return null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name, depth + 1); if (hit) return hit; }
  }
  return null;
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_PUBLIC_ORIGIN: `http://127.0.0.2:${PORT}`, ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: projectsDir, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_API_KEY: KEY,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  for (const k of ["FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let worker;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    worker = spawn(process.execPath, [join(backendCwd, "dist/localWorker/entry.js")], {
      cwd: computer,
      env: { ...process.env, ORVYN_CONTROL_PLANE: BASE, ORVYN_API_KEY: KEY, ORVYN_PROJECT_ROOT: "", ORVYN_DATA_DIR: mkdtempSync(join(tmpdir(), "orvyn-lf-wdata-")) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    worker.stdout.on("data", (d) => log.push(`[worker] ${d}`)); worker.stderr.on("data", (d) => log.push(`[worker] ${d}`));
    for (let i = 0; i < 40; i++) {
      const h = await api("/local-worker/health");
      if (h.json?.state === "ready" || h.json?.online === true || h.json?.workers?.length) break;
      await sleep(250);
    }

    console.log("\n1. Build the site in a folder on the user's computer");
    const build = await runTask("Build a simple VirPhone website, it's a wholesale VoIP carrier", { projectRoot: DESKTOP_FOLDER });
    const exec1 = [...build.events].reverse().find((e) => e.type === "run.execution")?.data ?? {};
    ok(build.status === "completed" && exec1.executionTargetActual === "local_host", "the build ran on the user's computer and finished", `${build.status} ${JSON.stringify(build.events.filter((e) => /error|failed/.test(e.type)).map((e) => [e.type, e.data?.tool, e.data?.error ?? e.data?.message]).slice(-5))}`);
    const onComputer = findFile(computer, "styles.css");
    ok(Boolean(onComputer), "styles.css is on the user's computer", computer);
    const bound = build.events.find((e) => e.type === "workspace.resolved")?.data?.projectRoot ?? "";

    console.log("\n2. Follow-up in the same chat (the desktop sends the chat's bound workspace)");
    const follow = await runTask("Can you add a animated hero background?", { sessionId: build.sessionId, previousRunId: build.runId, projectRoot: bound });
    const exec2 = [...follow.events].reverse().find((e) => e.type === "run.execution")?.data ?? {};
    ok(follow.status === "completed", "the follow-up finished", `${follow.status} ${JSON.stringify(follow.events.filter((e) => /error|failed/.test(e.type)).map((e) => e.data?.error ?? e.data?.message).slice(-4))}`);
    ok(exec2.executionTargetActual === "local_host", "it ran on the user's computer again (not an empty Cloud copy)", JSON.stringify(exec2).slice(0, 240));
    ok(seen.followRead.includes(".hero") && !/ENOENT/.test(seen.followRead), "reading styles.css returned the file it built", seen.followRead.slice(0, 160));
    ok(onComputer && readFileSync(onComputer, "utf8").includes("heroShift"), "the animated background was written into styles.css on the user's computer");
    const types = follow.events.map((e) => e.type);
    const firstPreview = types.indexOf("preview.available");
    const firstTool = types.indexOf("tool.started");
    ok(firstPreview >= 0 && (firstTool < 0 || firstPreview < firstTool), "the site's preview opened at the start of the follow-up", `preview@${firstPreview} tool@${firstTool}`);
    const urls = follow.events.filter((e) => e.type === "preview.available" || e.type === "preview.updated").map((e) => String(e.data?.url ?? "")).filter(Boolean);
    const url = urls[urls.length - 1] ?? "";
    const css = url ? await (await fetch(new URL("styles.css", url))).text() : "";
    ok(css.includes("heroShift"), "the preview serves the updated stylesheet", `${url} ${css.slice(0, 80)}`);
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    worker?.kill("SIGKILL"); server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-3000));
  console.log(failures === 0 ? "\nLOCAL FOLLOW-UP: PASS" : `\nLOCAL FOLLOW-UP: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
