// scripts/acceptance/phase2-agent-loop.mjs
//
// PHASE 2 acceptance — ONE user message drives a multi-step loop:
//
//   "Create a small JavaScript project with package.json, index.js, a test,
//    run the test, and fix it if it fails."
//
// Required loop: MODEL → TOOL → RESULT → SAME RUN → NEXT TOOL → … → VERIFY →
// FINAL. The scripted model writes a project with a real bug, so the first
// `npm test` genuinely fails; it must see that failure, repair the code, and
// re-run the tests — all without another user message. Tests really run
// (node --test via npm) in a temp project.
//
// What this proves: runtime, ToolGateway, tool results, failure feedback and
// the repair re-run. What it cannot prove: that a real model chooses these
// steps — run the same prompt once in the app to close Phase 2.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/phase2-agent-loop.mjs

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PROMPT = "Create a small JavaScript project with package.json, index.js, a test, run the test, and fix it if it fails.";
const PORT = 4641;
const MODEL_PORT = 4642;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");

const BUGGY = "function add(a, b) {\n  return a - b;\n}\nmodule.exports = { add };\n";
const TEST = "const test = require(\"node:test\");\nconst assert = require(\"node:assert\");\nconst { add } = require(\"./index.js\");\n\ntest(\"add adds\", () => {\n  assert.strictEqual(add(2, 3), 5);\n});\n";
const PKG = JSON.stringify({ name: "calc", version: "1.0.0", private: true, scripts: { test: "node --test" } }, null, 2) + "\n";

// Two ways to run the tests: the run_tests tool, and "npm test" in the terminal.
const VARIANTS = process.env.VARIANT ? [process.env.VARIANT] : ["run_tests", "terminal"];
let VARIANT = VARIANTS[0];
const isTestCall = (r) => (VARIANT === "terminal" ? r.name === "terminal" && /npm test/.test(String(r.args.command ?? "")) : r.name === "run_tests");
const testCall = () => (VARIANT === "terminal" ? { name: "terminal", args: { command: "npm test" } } : { name: "run_tests", args: {} });

// Scripted model: reads the conversation and picks the next step, like a real model.
const modelLog = [];
function nextTurn(body) {
  // The independent verifier (VerificationRuntime) asks the same model; this stand-in approves and lets the automatic read-only checks decide.
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (tools.length === 0) return { text: "OK." };
  const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  const results = msgs.filter((m) => m.role === "tool").map((m) => {
    const call = asked.find((c) => c.id === m.tool_call_id);
    let args = {}; try { args = JSON.parse(call?.function?.arguments ?? "{}"); } catch {}
    return { name: call?.function?.name, args, content: String(m.content ?? "") };
  });
  const wrote = (p) => results.some((r) => (r.name === "write_file" || r.name === "edit_file") && r.args.path === p && !/FAILED/.test(r.content));
  const testRuns = results.filter(isTestCall);
  const lastTest = testRuns[testRuns.length - 1];
  const fixed = results.some((r) => r.name === "edit_file" && r.args.path === "index.js" && !/FAILED/.test(r.content));

  if (!wrote("package.json")) return { text: "I'll set up a small project: package.json, index.js with an add function, and a test. Then I'll run the test and fix anything that fails.", call: { name: "write_file", args: { path: "package.json", content: PKG } } };
  if (!wrote("index.js")) return { text: "", call: { name: "write_file", args: { path: "index.js", content: BUGGY } } };
  if (!wrote("index.test.js")) return { text: "", call: { name: "write_file", args: { path: "index.test.js", content: TEST } } };
  if (!lastTest) return { text: "The files are in place. Running the test now.", call: testCall() };
  const failedNow = /FAILED|exit [1-9]|not ok/i.test(lastTest.content);
  if (failedNow && !fixed) return { text: "The test failed: add() subtracts instead of adding. Fixing index.js.", call: { name: "edit_file", args: { path: "index.js", old_string: "return a - b;", new_string: "return a + b;" } } };
  if (failedNow && fixed && testRuns.length < 2) return { text: "Re-running the test after the fix.", call: testCall() };
  if (fixed && testRuns.length >= 2 && !failedNow) return { text: "Done. I created package.json, index.js and index.test.js. The first test run failed because add() subtracted; I fixed it to a + b, re-ran the tests, and they pass now (1 test, 0 failures)." };
  if (!failedNow && !fixed) return { text: "Done. The project is created and its test passes." };
  return { text: `I could not finish: last test output was ${lastTest.content.slice(0, 160)}` };
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
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-p2-data-"));
const projectDir = mkdtempSync(join(tmpdir(), "orvyn-p2-project-"));
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
  const deadline = Date.now() + 120_000;
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


function evaluate(label, { runId, status, events, approvals }) {
  console.log(`\n${label}  (run ${runId}, ${approvals} approval(s))`);
  const types = events.map((e) => e.type);
  const calls = new Map();
  for (const e of events) if (e.type === "tool.input") calls.set(e.data.callId, e.data.input ?? {});
  const finished = events.filter((e) => e.type === "tool.completed" || e.type === "tool.failed").map((e) => ({ tool: e.data.tool, ok: e.type === "tool.completed", args: calls.get(e.data.callId) ?? {}, repeated: e.data.repeated }));
  const seq = finished.map((f) => `${f.tool}${f.ok ? "" : "✗"}`).join(" → ");
  console.log(`        tools: ${seq}`);
  const chatText = events.filter((e) => e.type === "message.delta").map((e) => e.data?.content ?? "").join("");

  ok(status === "completed", "run ends COMPLETED", `status=${status}; ${JSON.stringify(events.filter((e) => /error|blocked/.test(e.type)).map((e) => e.data)).slice(0, 400)}`);
  ok(finished.length >= 5, "one user message drove at least 5 sequential tool calls", `got ${finished.length}`);
  ok(events.filter((e) => e.type === "tool.started").length >= finished.filter((f) => !f.repeated).length, "every executed tool went through the gateway (tool.started → result)");
  const writes = finished.filter((f) => f.tool === "write_file" && f.ok).map((f) => f.args.path);
  ok(["package.json", "index.js", "index.test.js"].every((p) => writes.includes(p)), "multiple files created: package.json, index.js, index.test.js", writes.join(", "));
  ok(["package.json", "index.js", "index.test.js"].every((p) => existsSync(join(projectDir, p))), "the files exist in the workspace");
  const tests = finished.filter((f) => (VARIANT === "terminal" ? f.tool === "terminal" && /npm test/.test(String(f.args.command ?? "")) : f.tool === "run_tests"));
  ok(tests.length >= 2, "the test ran, then ran again", `run_tests x${tests.length}`);
  ok(tests[0] && tests[0].ok === false, "the first run's failure reached the loop as a failure", JSON.stringify(tests[0] ?? null));
  const fixIdx = finished.findIndex((f) => f.tool === "edit_file" && f.ok && f.args.path === "index.js");
  ok(fixIdx > finished.indexOf(tests[0]), "the failure was repaired (index.js edited after the failing run)");
  ok(!finished.some((f) => f.repeated), "the re-run after the fix was not refused as an identical retry", seq);
  const lastTest = tests[tests.length - 1];
  ok(lastTest && lastTest.ok === true && finished.lastIndexOf(lastTest) > fixIdx, "the test was re-run after the fix and passed");
  ok(/return a \+ b;/.test(readFileSync(join(projectDir, "index.js"), "utf8")), "index.js contains the fix");
  let independent = false;
  try { execSync("npm test", { cwd: projectDir, stdio: "ignore" }); independent = true; } catch {}
  ok(independent, "npm test passes when run independently in the project");
  const lastIdx = (t) => types.lastIndexOf(t);
  ok(lastIdx("message.delta") > Math.max(lastIdx("tool.completed"), lastIdx("tool.failed")) && lastIdx("run.completed") > lastIdx("message.delta"), "final response comes after the last tool, then the run completes");
  ok(/pass/i.test(chatText.slice(-400)), "final answer reports the passing tests", chatText.slice(-200));
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
    for (const variant of VARIANTS) {
      VARIANT = variant;
      for (const f of ["package.json", "index.js", "index.test.js"]) rmSync(join(projectDir, f), { force: true });
      const outcome = await runPrompt("full_access");
      evaluate(`Phase 2 · one message, repair loop · tests via ${variant === "terminal" ? "terminal (npm test)" : "run_tests"}`, outcome);
      if (process.env.VERBOSE) for (const e of outcome.events) if (e.type !== "message.delta") console.log(`    ${e.type} ${JSON.stringify(e.data).slice(0, 180)}`);
    }
  } catch (err) {
    failures++;
    console.error("HARNESS ERROR:", err.message);
    console.error(serverLog.join("").slice(-3000));
  } finally {
    server.kill();
    modelServer.close();
  }
  console.log(failures === 0 ? "\nPHASE 2: PASS" : `\nPHASE 2: FAIL (${failures} check${failures === 1 ? "" : "s"})`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
