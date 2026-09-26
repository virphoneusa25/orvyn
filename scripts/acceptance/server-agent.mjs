// scripts/acceptance/server-agent.mjs
//
// The Server agent's three cost and safety controls, end to end through the
// real engine (every provider served by one scripted model):
//
//   1. Big command output is condensed: the user's stream keeps the full
//      output, the main model reads a digest made by the cheap utility model
//      (error lines verbatim).
//   2. Command risk: read-only commands run without asking; a restart asks in
//      Auto Workspace; a change runs in Full Access; a dangerous command
//      (rm -rf) asks even in Full Access.
//   3. Per-step routing: after two look-only steps, a cheaper helper takes the
//      next look; a helper step that wants to change something is discarded
//      and the main model takes the turn.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/server-agent.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4771, MODEL_PORT = 4772;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const project = mkdtempSync(join(tmpdir(), "orvyn-srv-project-"));
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-srv-data-"));

// A 60,000-character "journal": noise plus a few real errors.
const journal = [];
for (let i = 0; i < 900; i++) {
  journal.push(`Sep 25 10:${String(i % 60).padStart(2, "0")}:01 web nginx[811]: 10.0.0.${i % 250} - GET /health 200 12ms upstream=app:3000`);
  if (i % 150 === 7) journal.push(`Sep 25 10:${String(i % 60).padStart(2, "0")}:02 web nginx[811]: [error] connect() failed (111: Connection refused) while connecting to upstream app:3000`);
}
journal.push("Sep 25 10:59:59 web systemd[1]: app.service: Main process exited, code=exited, status=1/FAILURE");
writeFileSync(join(project, "journal.log"), journal.join("\n") + "\n");
const RAW_CHARS = journal.join("\n").length;
spawnSync("git", ["init", "-q"], { cwd: project });

const MODELS = { gemini: "gemini-3.8-flash", deepseek32: "deepseek/deepseek-v3.2", small: "mistral-small-4-0-26-03", sol: "gpt-5.6-sol" };
const calls = []; // { model, user, helper, condensedSeen, digest }

function toolResultsSinceUser(msgs) {
  const i = msgs.map((m) => m.role === "user" && !String(m.content).startsWith("[") && !/^Budget note/.test(String(m.content))).lastIndexOf(true);
  return msgs.slice(i).filter((m) => m.role === "tool");
}
const cmd = (command) => ({ name: "terminal", args: { command } });

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const last = String(msgs[msgs.length - 1]?.content ?? "");
  const user = String([...msgs].reverse().find((m) => m.role === "user" && !/^(Budget note|\[)/.test(String(m.content)))?.content ?? "");
  const m = String(body.model ?? "");
  const helper = last.startsWith("[ORVYN step note]");
  const toolText = msgs.filter((x) => x.role === "tool").map((x) => String(x.content)).join("\n");
  calls.push({ model: m, user: user.slice(0, 60), helper, condensedSeen: toolText.includes("[ORVYN condensed this output"), rawSeen: toolText.length > RAW_CHARS * 0.9, digest: system.includes("You condense command output") });
  if (system.includes("You condense command output")) return { text: "Nginx cannot reach the upstream app:3000 (7× connect() failed, Connection refused). app.service exited with status=1/FAILURE at 10:59:59." };
  if (system.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Checked." };
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const since = toolResultsSinceUser(msgs);
  const n = since.length;

  if (/Diagnose the nginx 502/.test(user)) {
    if (helper) return { text: "Checking load.", call: cmd("uptime") };
    if (n === 0) return { text: "Checking disk first.", call: cmd("df -h .") };
    if (n === 1) return { text: "Reading the journal.", call: cmd("cat journal.log") };
    if (n === 3) return { text: "Restarting the app.", call: cmd("systemctl restart app") };
    return { text: `The app service crashed, so nginx returns 502 (diagnosed by ${m}).` };
  }
  if (/Inspect the nginx config/.test(user)) {
    if (helper) return { text: "I'll fix it now.", call: { name: "write_file", args: { path: "app.conf", content: "port=3001\n" } } };
    if (n === 0) return { text: "Listing.", call: cmd("ls -la") };
    if (n === 1) return { text: "Reading.", call: cmd("head -n 3 journal.log") };
    return { text: `The config is fine (checked by ${m}).` };
  }
  if (/Clean the nginx build cache/.test(user)) {
    if (n === 0) return { text: "Creating the cache folder.", call: cmd("mkdir -p cache") };
    if (n === 1) return { text: "Removing it.", call: cmd("rm -rf cache") };
    return { text: `Stopped at the removal (${m}).` };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: ["scripted-agent", "gpt-5.6-luna", "gpt-5.6-sol", "claude-sonnet-5", ...Object.values(MODELS)].map((id) => ({ id })) }));
    }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const toolCalls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
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

/** Runs a task; every approval request is answered by `answer(event)` (true = allow). */
async function runTask(instruction, permissionMode, answer = () => false) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot: project, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode });
  const runId = started.json.runId;
  const answered = new Set();
  for (let i = 0; i < 240; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    const events = r.json.events ?? [];
    for (const e of events) {
      if (e.type !== "approval.required" || answered.has(e.data.callId)) continue;
      answered.add(e.data.callId);
      await api(`/agent/stream/approvals/${e.data.callId}`, "POST", { approved: Boolean(answer(e)), scope: "once" });
    }
    if (["completed", "error", "cancelled", "blocked"].includes(r.json.status)) return { runId, status: r.json.status, events };
    await sleep(200);
  }
  const r = await api(`/agent/stream/runs/${runId}/events.json`);
  return { runId, status: r.json.status, events: r.json.events ?? [] };
}
const approvals = (ev) => ev.filter((e) => e.type === "approval.required").map((e) => ({ command: String(e.data.input?.command ?? ""), risk: e.data.risk, destructive: e.data.destructive }));
const toolDone = (ev, command) => ev.find((e) => e.type === "tool.completed" && ev.some((s) => (s.type === "tool.input" || s.type === "tool.started") && s.data.callId === e.data.callId && String(s.data.input?.command ?? s.data.args?.command ?? "") === command));

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
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.ORVYN_ALLOW_ULTRA_ESCALATION; delete env.ORVYN_CONDENSE_OVER_CHARS;
  for (const k of ["DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Diagnose a 502 in Auto Workspace (read-only runs, big output condensed, helper step, restart asks)");
    const a = await runTask("Diagnose the nginx 502 using the journal.log in this project", "auto_workspace", () => false);
    const startedA = a.events.find((e) => e.type === "run.started")?.data ?? {};
    ok(startedA.route?.profile === "server" && startedA.actualModelId === `gemini:${MODELS.gemini}`, "the Server agent runs on Gemini 3.8 Flash", `${startedA.route?.profile} ${startedA.actualModelId}`);
    const asked = approvals(a.events);
    ok(toolDone(a.events, "df -h .") && toolDone(a.events, "cat journal.log") && !asked.some((x) => /df|cat|uptime/.test(x.command)), "read-only commands (df, cat, uptime) ran without asking", JSON.stringify(asked));
    const cond = a.events.find((e) => e.type === "tool.output.condensed");
    ok(cond && cond.data.fromChars > 50000 && cond.data.toChars < 8000 && cond.data.digestModel === `mistral:${MODELS.small}`, `the ${cond?.data?.fromChars} character journal reached the model as a ${cond?.data?.toChars} character digest (by Mistral Small 4)`, JSON.stringify(cond?.data ?? null));
    const fullShown = a.events.filter((e) => e.type === "terminal.output" && e.data.callId === cond?.data?.callId).reduce((n, e) => n + String(e.data.data ?? "").length, 0) > 50000;
    ok(fullShown, "the user's stream still carries the full output");
    const mainAfter = calls.filter((c) => c.model === MODELS.gemini && /Diagnose/.test(c.user) && !c.digest);
    ok(mainAfter.some((c) => c.condensedSeen) && !mainAfter.some((c) => c.rawSeen), "the main model read the digest, never the raw journal");
    const step = a.events.find((e) => e.type === "route.step");
    ok(step?.data?.accepted === true && step.data.modelId === `openrouter:${MODELS.deepseek32}` && calls.some((c) => c.helper && c.model === MODELS.deepseek32), "after two look-only steps, DeepSeek V3.2 took the next look (uptime)", JSON.stringify(step?.data ?? null));
    ok(toolDone(a.events, "uptime"), "…and its read-only command ran");
    const restart = asked.find((x) => /systemctl restart/.test(x.command));
    ok(restart && restart.risk === "change" && !restart.destructive, "systemctl restart asked in Auto Workspace (risk: change)", JSON.stringify(asked));
    ok(a.status === "completed" && !calls.some((c) => c.model === MODELS.sol), "the run finished without GPT-5.6 Sol", a.status);

    console.log("\n2. A helper step that wants to change something is discarded");
    const b = await runTask("Inspect the nginx config and the log", "full_access");
    const rej = b.events.find((e) => e.type === "route.step" && e.data.accepted === false);
    ok(Boolean(rej) && /change something/.test(rej.data.reason ?? ""), "the helper's write_file step was rejected", JSON.stringify(b.events.filter((e) => e.type === "route.step").map((e) => e.data)));
    ok(!b.events.some((e) => e.type === "tool.started" && e.data.tool === "write_file"), "…and nothing was written");
    ok(b.status === "completed" && calls.some((c) => c.model === MODELS.gemini && /Inspect the nginx config/.test(c.user) && !c.helper && !c.digest), "the main model took the turn and finished", b.status);

    console.log("\n3. Full Access: a change runs, a dangerous command still asks");
    const c = await runTask("Clean the nginx build cache", "full_access", () => false);
    const askedC = approvals(c.events);
    ok(toolDone(c.events, "mkdir -p cache") && !askedC.some((x) => /mkdir/.test(x.command)), "mkdir ran without asking in Full Access");
    const rm = askedC.find((x) => /rm -rf/.test(x.command));
    ok(rm && rm.risk === "dangerous" && rm.destructive, "rm -rf asked even in Full Access (risk: dangerous)", JSON.stringify(askedC));
    ok(!toolDone(c.events, "rm -rf cache"), "…and did not run after the user denied it");
    if (failures) for (const r of [a, c]) console.log(JSON.stringify(r.events.filter((e) => /^tool\.|approval|run\.(error|blocked)|blocked/.test(e.type)).map((e) => ({ t: e.type, ...Object.fromEntries(Object.entries(e.data).map(([k, v]) => [k, String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 160)])) })), null, 1).slice(0, 6000));
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- calls ---\n" + calls.map((c) => `${c.model} helper=${c.helper} digest=${c.digest} cond=${c.condensedSeen} raw=${c.rawSeen} | ${c.user}`).join("\n") + "\n--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(failures === 0 ? "\nSERVER AGENT: PASS" : `\nSERVER AGENT: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
