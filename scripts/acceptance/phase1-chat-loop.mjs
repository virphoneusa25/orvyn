// scripts/acceptance/phase1-chat-loop.mjs
//
// PHASE 1 acceptance — Chat + continuous agent loop.
//
//   "Create hello.txt with Hello World, read it back, then tell me what it contains."
//
// Boots the BUILT backend against a scripted OpenAI-compatible model server
// (no real provider needed), sends the prompt through the same route the
// desktop composer uses (POST /agent/stream/runs), and checks the whole chain:
//
//   user message → ORION replies → write_file executes → result returns to the
//   SAME run → read_file executes → result returns → truthful final answer.
//
// What this proves: the runtime, routes, ToolGateway and event stream. What
// it cannot prove: that a real model chooses these calls — run the same
// prompt once in the app with a real model to close Phase 1.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/phase1-chat-loop.mjs

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Scenarios: "direct" (model calls every tool itself) and "announce" (model
// announces the next step in prose and stops — must still finish).
const SCENARIOS = process.env.SCENARIO ? [process.env.SCENARIO] : ["direct", "announce"];
let SCENARIO = SCENARIOS[0];
const PROMPT = "Create hello.txt with Hello World, read it back, then tell me what it contains.";
const PORT = 4611;
const MODEL_PORT = 4612;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");

// ---------------------------------------------------------------------------
// Scripted model: decides the next step from the conversation it is sent, the
// way a real model would — nothing is keyed to call counts.
// ---------------------------------------------------------------------------
const modelLog = [];
function nextTurn(body) {
  // The independent verifier (VerificationRuntime) asks the same model; this stand-in approves and lets the automatic read-only checks decide.
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (tools.length === 0) {
    // Side calls (titles, summaries, classification) — answer briefly.
    return { text: "OK." };
  }
  const toolMsgs = msgs.filter((m) => m.role === "tool");
  const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const nameOf = (id) => asked.find((c) => c.id === id)?.function?.name;
  const last = toolMsgs[toolMsgs.length - 1];
  const wrote = toolMsgs.some((m) => nameOf(m.tool_call_id) === "write_file");
  const readMsg = [...toolMsgs].reverse().find((m) => nameOf(m.tool_call_id) === "read_file");

  if (!wrote && tools.includes("write_file")) {
    return {
      text: "I'll create hello.txt with the text Hello World, then read it back to confirm.",
      call: { name: "write_file", args: { path: "hello.txt", content: "Hello World" } },
    };
  }
  // SCENARIO=announce: a common real-model failure — after the first tool the
  // model ANNOUNCES the next step in prose and ends its turn without calling
  // a tool. The runtime must not accept that as the final answer.
  const nudgedSinceTool = msgs.length > 0 && msgs[msgs.length - 1].role === "user" && toolMsgs.length > 0;
  if (SCENARIO === "announce" && wrote && !readMsg && !nudgedSinceTool) {
    return { text: "hello.txt is created. Next, I'll read it back to confirm what it contains." };
  }
  if (wrote && !readMsg && tools.includes("read_file")) {
    return {
      text: "The file is written. Reading it back now.",
      call: { name: "read_file", args: { path: "hello.txt" } },
    };
  }
  if (readMsg) {
    const raw = String(readMsg.content ?? "");
    const says = /Hello World/.test(raw) ? "Hello World" : raw.slice(0, 80);
    return { text: `Done. I created hello.txt and read it back — it contains exactly: "${says}".` };
  }
  return { text: `I could not continue: last tool result was ${String(last?.content ?? "none").slice(0, 120)}` };
}

let callSeq = 0;
const modelServer = createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] }));
    }
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    modelLog.push({ tools: (body.tools ?? []).length, messages: (body.messages ?? []).length, turn });
    const id = `call_${++callSeq}`;
    const toolCalls = turn.call
      ? [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }]
      : undefined;
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({
        choices: [{ message: { role: "assistant", content: turn.text, tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const piece of turn.text.match(/[\s\S]{1,12}/g) ?? []) send({ choices: [{ index: 0, delta: { content: piece } }] });
    if (toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

// ---------------------------------------------------------------------------
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-p1-data-"));
const projectDir = mkdtempSync(join(tmpdir(), "orvyn-p1-project-"));
execSync("git init -q", { cwd: projectDir });

const neutral = [
  "ORVYN_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY",
  "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY",
  "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID", "ORCHESTRATOR_MODEL", "OPENAI_CODE_MODEL",
].reduce((a, k) => ({ ...a, [k]: "" }), {});

let failures = 0;
const ok = (cond, label, detail = "") => {
  console.log(`${cond ? "  PASS" : "  FAIL"}  ${label}${!cond && detail ? `\n        ${detail}` : ""}`);
  if (!cond) failures++;
};

async function waitForHealth() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("backend did not become healthy");
}

async function runPrompt(permissionMode) {
  const res = await fetch(`${BASE}/api/v1/agent/stream/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Same payload shape as orvynCommand.startPlanRun().
    body: JSON.stringify({
      projectRoot: projectDir, remoteProjectRoot: projectDir, executionTarget: "auto",
      composerMode: "auto", instruction: PROMPT, mode: "agent", permissionMode,
    }),
  });
  const started = await res.json();
  if (!res.ok || !started.runId) throw new Error(`run did not start: ${JSON.stringify(started)}`);
  const runId = started.runId;

  // Poll like the app's fallback path; approve anything that asks, exactly as
  // a user clicking Approve would (Ask mode must still finish from ONE prompt).
  const approved = new Set();
  let after = 0, status = "running";
  const events = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events.json?after=${after}`);
    const data = await r.json();
    for (const e of data.events ?? []) {
      events.push(e);
      after = Math.max(after, Number(e.sequence ?? after));
      if (e.type === "approval.required" && !approved.has(e.data.callId)) {
        approved.add(e.data.callId);
        await fetch(`${BASE}/api/v1/agent/stream/approvals/${e.data.callId}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true, scope: "once" }),
        });
      }
    }
    status = data.status;
    if (!["running", "queued", "awaiting_approval", "verifying"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return { runId, status, events, approvals: approved.size };
}

// The desktop app's own presentation reducer decides what the CHAT shows.
// Running it over the real event stream checks the UI half of Phase 1.
let reduce = null;
try {
  ({ reducePresentation: reduce } = await import(
    pathToFileURL(join(repoRoot, "apps", "desktop", "src", "renderer", "presentationReducer.ts")).href
  ));
} catch (err) {
  console.log(`  (chat reducer not loaded — run with node >= 22.6 for .ts imports: ${err.message.split("\n")[0]})`);
}

function evaluate(label, { runId, status, events, approvals }) {
  console.log(`\n${label}  (run ${runId}, ${approvals} approval(s))`);
  const types = events.map((e) => e.type);
  const results = events.filter((e) => e.type === "tool.completed");
  const resultTools = results.map((e) => e.data?.tool ?? e.data?.name);
  const chatText = events.filter((e) => e.type === "message.delta").map((e) => e.data?.content ?? "").join("");
  const lastIdx = (t) => types.lastIndexOf(t);

  ok(status === "completed", "run ends COMPLETED", `status=${status}; tail: ${types.slice(-6).join(", ")}; ${JSON.stringify(events.filter((e) => /error|blocked/.test(e.type)).map((e) => e.data)).slice(0, 400)}`);
  ok(chatText.trim().length > 0 && types.indexOf("message.delta") >= 0 && types.indexOf("message.delta") < types.indexOf("tool.started"), "ORION speaks before the first tool result");
  ok(resultTools.includes("write_file"), "write_file executed and its result returned to the run", `tool results: ${resultTools.join(", ") || "(none)"}`);
  ok(resultTools.includes("read_file"), "read_file executed in the SAME run after write_file", `tool results: ${resultTools.join(", ") || "(none)"}`);
  ok(resultTools.indexOf("write_file") < resultTools.indexOf("read_file"), "tools ran in order: write → read");
  const file = join(projectDir, "hello.txt");
  ok(existsSync(file) && readFileSync(file, "utf8").trim() === "Hello World", "hello.txt exists in the workspace with Hello World");
  const finalSays = /contains[^"]*"Hello World"/i.test(chatText);
  ok(finalSays, "final answer truthfully states the content", chatText.slice(-200));
  ok(lastIdx("run.completed") > lastIdx("tool.completed") && lastIdx("message.delta") > lastIdx("tool.completed"), "final response comes after the last tool result");
  const dupes = events.length - new Set(events.map((e) => e.sequence)).size;
  ok(dupes === 0, "every event delivered once (no replayed narration)", `${dupes} duplicate event(s)`);
  const leaked = /CREATED hello\.txt|"path":|\btool_call\b|\{"content"/.test(chatText);
  ok(!leaked, "no raw tool output in the chat stream (it belongs in Activity)", leaked ? chatText.slice(0, 300) : "");

  if (reduce) {
    const items = reduce(events, status);
    const said = items.filter((i) => i.kind === "assistant").map((i) => i.content).join("\n");
    // Tool work renders as compact rows, possibly folded into group rows.
    const rows = items.flatMap((i) => i.kind === "tool" ? [i] : (i.kind === "group" || i.kind === "workgroup") ? i.items : []);
    ok(/read it back/i.test(said) && /contains[^"]*"Hello World"/i.test(said), "chat shows ORION's progress and final answer", said.slice(0, 300));
    ok(rows.length >= 2 && rows.every((r) => r.status === "done"), "tool work shows as compact rows, all done", JSON.stringify(rows.map((r) => [r.toolName, r.status])));
    ok(!/[{}]"?(path|content|callId)"?:/.test(said), "no raw JSON/tool payloads in chat text");
    const last = items.filter((i) => ["assistant", "tool", "group", "workgroup"].includes(i.kind)).pop();
    ok(last?.kind === "assistant", "the last thing in the chat is ORION's answer, not a tool row", `last item: ${last?.kind}`);
  }
}

async function main() {
  await new Promise((r) => modelServer.listen(MODEL_PORT, "127.0.0.1", r));
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: join(repoRoot, "apps", "backend"),
    env: {
      ...process.env, ...neutral,
      MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent",
      ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const serverLog = [];
  server.stdout.on("data", (d) => serverLog.push(String(d)));
  server.stderr.on("data", (d) => serverLog.push(String(d)));
  try {
    await waitForHealth();
    for (const scenario of SCENARIOS) for (const mode of ["auto_workspace", "ask"]) {
      SCENARIO = scenario;
      rmSync(join(projectDir, "hello.txt"), { force: true });
      const outcome = await runPrompt(mode);
      evaluate(`Scenario: ${scenario} · permission mode: ${mode}`, outcome);
      if (process.env.VERBOSE) {
        for (const e of outcome.events) if (e.type !== "message.delta") console.log(`    ${e.type} ${JSON.stringify(e.data).slice(0, 180)}`);
      }
    }
  } catch (err) {
    failures++;
    console.error("HARNESS ERROR:", err.message);
    console.error(serverLog.join("").slice(-3000));
  } finally {
    server.kill();
    modelServer.close();
  }
  console.log(`\nscenarios: ${SCENARIOS.join(", ")} · model calls: ${modelLog.length}`);
  console.log(failures === 0 ? "\nPHASE 1: PASS" : `\nPHASE 1: FAIL (${failures} check(s))`);
  process.exit(failures === 0 ? 0 : 1);
}
main();
