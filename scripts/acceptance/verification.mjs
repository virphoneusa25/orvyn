// scripts/acceptance/verification.mjs
//
// VerificationRuntime acceptance.
//
// ONE run builds a deliberately broken website (index.html loads style.css,
// which is never written, and app.js, which has a syntax error). The working
// agent believes it is done and says so. Then:
//
//   1. the independent verifier (read-only) must return FAIL, with findings
//      that name the missing stylesheet and the broken script;
//   2. the findings go back to the SAME run, and the run is NOT completed;
//   3. the agent fixes the site;
//   4. the verifier must return PASS;
//   5. only then may the completion evaluator approve completion.
//
// The verifier opens the published page in the browser (the Workbench when
// ORVYN Desktop is connected; here the server-side fallback browser) and
// reads the console and network errors itself. It also tries to write a file
// once, which must be refused: the verifier may only read and verify.
// Checked on Local (the real Local Worker) and Cloud.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/verification.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROMPT = "Build a small landing page website: index.html with a stylesheet and a script.";
const PORT = 4691, MODEL_PORT = 4692;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "verification-test-key-000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const laptopHome = mkdtempSync(join(tmpdir(), "orvyn-verify-laptop-"));
const LOCAL_ROOT = join(laptopHome, "site");
mkdirSync(LOCAL_ROOT, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-verify-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-verify-cloudprojects-"));

const HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Acme</title><link rel="stylesheet" href="style.css"></head>
<body><h1 id="title">Acme</h1><p>Rockets for everyone.</p><script src="app.js"></script></body>
</html>
`;
const BROKEN_JS = "document.getElementById('title').textContent = 'Acme Rockets';\nfunction launch( {\n  return 'go';\n";
const FIXED_JS = "document.getElementById('title').textContent = 'Acme Rockets';\nfunction launch() {\n  return 'go';\n}\n";
const CSS = "body { font-family: system-ui, sans-serif; margin: 2rem; }\nh1 { color: #1d4ed8; }\n";

const log = { agent: [], verifier: [] };

function parse(body) {
  const msgs = body.messages ?? [];
  const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const results = msgs.filter((m) => m.role === "tool").map((m) => {
    const call = asked.find((c) => c.id === m.tool_call_id);
    let args = {}; try { args = JSON.parse(call?.function?.arguments ?? "{}"); } catch {}
    return { name: call?.function?.name, args, content: String(m.content ?? "") };
  });
  return { msgs, results };
}

// The independent verifier: adversarial, read-only, decides from what it reads.
function verifierTurn(body) {
  const { msgs, results } = parse(body);
  const system = String(msgs[0]?.content ?? "");
  const url = (system.match(/Published page: (\S+)/) ?? [])[1];
  const round = log.verifier.filter((v) => v.start).length + (results.length === 0 ? 1 : 0);
  if (results.length === 0) log.verifier.push({ start: true, round });
  const n = results.length;
  if (n === 0) return { text: "", call: { name: "read_file", args: { path: "index.html" } } };
  if (n === 1 && round === 1) return { text: "", call: { name: "write_file", args: { path: "index.html", content: "<h1>verifier was here</h1>" } } };
  const step = round === 1 ? n - 1 : n; // round 1 spent one step on the refused write
  if (step === 1 && url) return { text: "", call: { name: "browser_open", args: { url } } };
  if (step === 2 && url) return { text: "", call: { name: "browser_console_errors", args: {} } };
  const errors = results.filter((r) => r.name === "browser_console_errors").pop()?.content ?? "";
  const bad = /\[(console|pageerror|network)|pageerror|404|failed/i.test(errors) && !/No console, page or network errors/i.test(errors);
  const writeRefused = results.some((r) => r.name === "write_file" && /read-only/.test(r.content));
  log.verifier.push({ round, errors: errors.split("\n").slice(0, 4).join(" | "), writeRefused });
  return bad
    ? { text: `VERDICT: FAIL\n- The page shows errors in the browser: ${errors.split("\n").filter((l) => /^\[/.test(l)).slice(0, 3).join("; ")}` }
    : { text: "VERDICT: PASS\n- index.html loads its stylesheet and script with no console or network errors." };
}

// The working agent: builds the site, believes it is done, fixes it when told.
function nextTurn(body) {
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return verifierTurn(body);
  const { msgs, results } = parse(body);
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  const findings = msgs.filter((m) => m.role === "user" && /^VERIFICATION (FAIL|PARTIAL)/.test(String(m.content)));
  log.agent.push({ tools: results.length, findings: findings.length });
  const wrote = (p, content) => results.some((r) => r.name === "write_file" && r.args.path === p && (!content || r.args.content === content));
  if (!findings.length) {
    if (!wrote("index.html")) return { text: "I'll build the landing page.", call: { name: "write_file", args: { path: "index.html", content: HTML } } };
    if (!wrote("app.js")) return { text: "", call: { name: "write_file", args: { path: "app.js", content: BROKEN_JS } } };
    return { text: "Done! The landing page website is complete: index.html, its stylesheet and its script." };
  }
  // The verifier's findings arrived in this same run: fix what it named.
  const f = String(findings[findings.length - 1].content);
  if (/style\.css/.test(f) && !wrote("style.css")) return { text: "The verifier is right: style.css was never written. Adding it.", call: { name: "write_file", args: { path: "style.css", content: CSS } } };
  if (/app\.js/.test(f) && !wrote("app.js", FIXED_JS)) return { text: "Fixing the syntax error in app.js.", call: { name: "write_file", args: { path: "app.js", content: FIXED_JS } } };
  void lastUser;
  return { text: "Fixed: style.css now exists and app.js parses. The landing page is complete." };
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
  const deadline = Date.now() + 120_000;
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

async function scenario(label, root, target, dir) {
  log.agent.length = 0; log.verifier.length = 0;
  const r = await run(PROMPT, root, target);
  if (r.refused) { ok(false, `${label}: run starts`, JSON.stringify(r.refused)); return; }
  const ev = r.events;
  const seqOf = (pred) => ev.filter(pred).map((e) => e.sequence);
  const verdicts = ev.filter((e) => e.type === "verification.completed").map((e) => e.data);
  console.log(`        verdicts: ${verdicts.map((v) => `#${v.attempt} ${v.verdict}`).join(" → ")}`);
  const first = verdicts[0];
  ok(first?.verdict === "FAIL", `${label}: the agent said it was done, and the verifier returned FAIL`, JSON.stringify(first ?? null).slice(0, 400));
  const findingText = (first?.findings ?? []).map((f) => f.message).join("\n");
  console.log(`        findings: ${(first?.findings ?? []).map((f) => f.message).join(" | ").slice(0, 420)}`);
  ok(/style\.css does not exist/.test(findingText), `${label}: a finding names the missing style.css`);
  ok(/app\.js does not parse/.test(findingText), `${label}: a finding names the syntax error in app.js`);
  ok(/errors? in the browser|console error|failed request/i.test(findingText), `${label}: the verifier's own browser check saw the page errors`, findingText.slice(0, 300));
  const failSeq = seqOf((e) => e.type === "verification.completed" && e.data.verdict === "FAIL")[0];
  const passSeq = seqOf((e) => e.type === "verification.completed" && e.data.verdict === "PASS")[0];
  const completedSeqs = seqOf((e) => e.type === "run.completed");
  ok(completedSeqs.length === 1 && completedSeqs[0] > (passSeq ?? Infinity), `${label}: the run was not completed after FAIL, only after PASS`, JSON.stringify({ failSeq, passSeq, completedSeqs }));
  ok(log.agent.some((a) => a.findings > 0), `${label}: the findings went back to the same run (the agent got them as its next input)`);
  ok(ev.filter((e) => e.type === "run.started").length === 1, `${label}: one run from start to finish`);
  const fixes = ev.filter((e) => e.type === "tool.completed" && !e.data.verifier && e.data.tool === "write_file" && e.sequence > failSeq).map((e) => e.data.envelope?.structuredData?.path);
  ok(fixes.includes("style.css") && fixes.includes("app.js"), `${label}: the agent fixed the site after the FAIL (${fixes.join(", ")})`);
  const last = verdicts[verdicts.length - 1];
  ok(last?.verdict === "PASS", `${label}: the verifier then returned PASS`, JSON.stringify(last ?? null).slice(0, 400));
  ok((last?.checks ?? []).every((c) => c.status === "pass" || c.status === "skip"), `${label}: every automatic check passed on the fixed site`, JSON.stringify(last?.checks ?? []));
  const finished = ev.find((e) => e.type === "agent.loop.finished")?.data;
  ok(r.status === "completed" && finished?.outcome === "completed" && /evaluator approved/.test(finished?.reason ?? ""), `${label}: only then did the completion evaluator approve completion`, JSON.stringify({ status: r.status, finished }));
  const verifierTools = ev.filter((e) => e.type === "tool.completed" || e.type === "tool.failed").filter((e) => e.data.verifier);
  const blockedWrite = verifierTools.find((e) => e.data.tool === "write_file");
  ok(blockedWrite?.type === "tool.failed" && /read-only/.test(String(blockedWrite?.data?.error)), `${label}: the verifier's attempt to write was refused (read-only)`, JSON.stringify(blockedWrite?.data ?? null).slice(0, 300));
  if (dir) {
    ok(readFileSync(join(dir, "index.html"), "utf8") === HTML, `${label}: index.html on disk is the agent's page (the verifier changed nothing)`);
    ok(existsSync(join(dir, "style.css")) && readFileSync(join(dir, "app.js"), "utf8") === FIXED_JS, `${label}: the fixed files are in the project`);
  }
  ok(verifierTools.some((e) => e.data.tool === "browser_console_errors"), `${label}: the verifier checked the page in the browser (${[...new Set(verifierTools.map((e) => e.data.tool))].join(", ")})`);
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: projectsDir, ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    // The control plane's public address, as users reach it. A loopback alias:
    // the completion gate (rightly) refuses previews on 127.0.0.1/localhost,
    // which from a worker would not be the user's machine.
    ORVYN_PUBLIC_ORIGIN: `http://127.0.0.2:${PORT}`,
    ORVYN_API_KEY: API_KEY, ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const slog = []; server.stdout.on("data", (d) => slog.push(String(d))); server.stderr.on("data", (d) => slog.push(String(d)));
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
    worker?.kill("SIGTERM"); server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + slog.join("").slice(-2000) + "\n--- verifier log ---\n" + JSON.stringify(log.verifier).slice(0, 1500));
  console.log(failures === 0 ? "\nVERIFICATION: PASS" : `\nVERIFICATION: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
