// scripts/smoke-streaming.mjs
//
// End-to-end verification of the conversation / streaming / run pipeline
// (the runtime-repair spec's test ladder, in order):
//
//   PART A — self-spawned backend on :4599 (mock model, zero keys):
//     1. simple chat streams over WS and creates NO mission
//     2. a tool task runs the full loop (approval → tool → completion)
//     3. a mission that cannot plan terminates (never permanent RUNNING)
//
//   PART B — live backend on :4570 (real routed models):
//     4. the spec's exact health-check mission reaches a TERMINAL run state,
//        with unanswered approvals auto-denied instead of hanging the run
//     5. a mission queued behind full concurrency reports queued truthfully
//
// Usage: node scripts/smoke-streaming.mjs          (run after `npm run build`)

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");
const LIVE = process.env.ORVYN_LIVE_BASE ?? "http://127.0.0.1:4570";
const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;

const dataDir = mkdtempSync(join(tmpdir(), "orvyn-stream-data-"));
const projectDir = mkdtempSync(join(tmpdir(), "orvyn-stream-project-"));
writeFileSync(join(projectDir, "hello.txt"), "hello stream\n");

const keyVars = [
  "ORVYN_API_KEY", "MODEL_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY",
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
  "OLLAMA_MODEL", "ASTRA_MODEL_ID", "ORCHESTRATOR_MODEL",
].reduce((acc, k) => ({ ...acc, [k]: "" }), {});

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: join(repoRoot, "apps", "backend"),
  env: { ...process.env, ...keyVars, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_APPROVAL_TIMEOUT_SEC: "30" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✔" : "  ✖"} ${label}`);
  if (!cond) failures++;
};

async function waitForHealth(base) {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${base}/api/v1/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`backend ${base} did not become healthy`);
}

/** Reads a run's SSE stream until terminal or timeout; onEvent sees every event. */
async function consume(base, runId, onEvent, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const res = await fetch(`${base}/api/v1/agent/stream/runs/${runId}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let terminal = null;
  while (Date.now() < deadline && !terminal) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      onEvent?.(ev);
      if (ev.type === "run.completed" || ev.type === "run.error" || ev.type === "run.cancelled") {
        terminal = ev;
        reader.cancel().catch(() => {});
        return terminal;
      }
    }
  }
  reader.cancel().catch(() => {});
  return terminal;
}

async function runStatus(base, runId) {
  const r = await fetch(`${base}/api/v1/agent/stream/runs/${runId}/events.json`);
  return (await r.json()).status;
}

async function missionCount(base) {
  const r = await fetch(`${base}/api/v1/missions`);
  const d = await r.json();
  return (d.missions ?? []).length;
}

async function approveCall(base, runId, callId, approved, path) {
  await fetch(`${base}/api/v1/${path}/${callId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved }),
  });
  void runId;
}

// ---------------------------------------------------------------------------
// PART A
// ---------------------------------------------------------------------------
async function partA() {
  console.log("\nPART A — pipeline on the self-spawned backend (mock model)");
  await waitForHealth(BASE);

  // 1. Simple chat streams and never becomes a mission -----------------------
  {
    console.log("1. simple chat streams (WS) and creates no mission");
    const before = await missionCount(BASE);
    const reply = await new Promise((resolveChat, rejectChat) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
      const fail = setTimeout(() => { try { ws.close(); } catch {} rejectChat(new Error("chat WS timed out")); }, 12000);
      let text = "";
      ws.onopen = () =>
        ws.send(JSON.stringify({ task: "chat", history: [], userMessage: "Write a detailed explanation of how ORVYN's agent architecture should work.", context: { projectRoot: projectDir, useRag: false } }));
      ws.onmessage = (m) => {
        const chunk = JSON.parse(m.data);
        if (chunk.error) { clearTimeout(fail); ws.close(); resolveChat({ error: chunk.error, text }); return; }
        text += chunk.delta ?? "";
        if (chunk.done) { clearTimeout(fail); ws.close(); resolveChat({ text }); }
      };
      ws.onerror = () => { clearTimeout(fail); rejectChat(new Error("chat WS error")); };
    });
    ok(!reply.error, "chat: no error event");
    ok(reply.text.length > 10, `chat: streamed ${reply.text.length} chars of reply`);
    const after = await missionCount(BASE);
    ok(after === before, `chat: no mission created (${before} → ${after})`);
  }

  // 2. Tool task: full loop with approval -----------------------------------
  {
    console.log("2. tool task runs the full loop (approval → tool → completion)");
    const res = await fetch(`${BASE}/api/v1/agent/stream/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectDir, instruction: "Create ORVYN_STREAM_TEST.md containing a short note that the ORVYN agent streaming test succeeded.", mode: "agent" }),
    });
    const { runId } = await res.json();
    const types = [];
    const terminal = await consume(BASE, runId, (ev) => {
      types.push(ev.type);
      if (ev.type === "approval.required") {
        approveCall(BASE, runId, ev.data.callId, true, "agent/stream/approvals").catch(() => {});
      }
    }, 25000);
    ok(terminal?.type === "run.completed", `tool task: run.completed (terminal=${terminal?.type})`);
    ok(types.includes("approval.required"), "tool task: approval was requested");
    ok(types.includes("tool.completed"), "tool task: a tool really executed");
    ok(existsSync(join(projectDir, "AGENT_NOTES.md")), "tool task: file actually exists on disk (mock writes AGENT_NOTES.md)");
  }

  // 3. A mission that cannot plan still terminates ---------------------------
  {
    console.log("3. unplannable mission terminates (no permanent RUNNING)");
    const res = await fetch(`${BASE}/api/v1/agent/orchestrate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectDir, goal: "Do something impossible to plan." }),
    });
    const { runId } = await res.json();
    const terminal = await consume(BASE, runId, () => {}, 60000);
    const status = await runStatus(BASE, runId);
    ok(["completed", "error", "cancelled"].includes(status), `mission: terminal status '${status}' (terminal event ${terminal?.type})`);
  }

  // 3b. SSE heartbeat arrives while a run is alive but quiet -----------------
  {
    console.log("3b. SSE heartbeat keeps a quiet live run distinguishable from a dead socket");
    // The mock demo run blocks on a write approval (30s timeout) — a stable
    // live-but-quiet run to observe the 15s heartbeat against.
    const res = await fetch(`${BASE}/api/v1/agent/stream/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectDir, instruction: "Write a notes file.", mode: "agent" }),
    });
    const { runId } = await res.json();
    const sse = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events`);
    const reader = sse.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !raw.includes(": hb")) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
      ]);
      if (done) break;
      raw += decoder.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    ok(raw.includes(": hb"), "heartbeat comment received within 20s on a quiet live run");
    await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/cancel`, { method: "POST" });
  }
}

// ---------------------------------------------------------------------------
// PART B
// ---------------------------------------------------------------------------
async function partB() {
  console.log(`\nPART B — live backend ${LIVE} (real models)`);
  try {
    await waitForHealth(LIVE);
  } catch {
    console.log("  (live backend not reachable — skipping PART B)");
    return;
  }

  // 4a. Multi-turn context: the codename test (spec Part 57) ----------------
  {
    console.log("4a. multi-turn chat retains context (Phoenix)");
    const livePort = new URL(LIVE).port || "80";
    const chatLive = (userMessage, history) =>
      new Promise((resolveChat, rejectChat) => {
        const ws = new WebSocket(`ws://127.0.0.1:${livePort}/ws/chat`);
        const fail = setTimeout(() => { try { ws.close(); } catch {} rejectChat(new Error("chat WS timed out")); }, 60000);
        let text = "";
        ws.onopen = () => ws.send(JSON.stringify({ task: "chat", history, userMessage, context: { projectRoot: repoRoot.replace(/\\/g, "/"), useRag: false } }));
        ws.onmessage = (m) => {
          const chunk = JSON.parse(m.data);
          if (chunk.error) { clearTimeout(fail); ws.close(); resolveChat({ error: chunk.error, text }); return; }
          text += chunk.delta ?? "";
          if (chunk.done) { clearTimeout(fail); ws.close(); resolveChat({ text }); }
        };
        ws.onerror = () => { clearTimeout(fail); rejectChat(new Error("chat WS error")); };
      });
    const r1 = await chatLive("My favorite test codename for this conversation is Phoenix.", []);
    ok(!r1.error && r1.text.length > 0, "phoenix: first turn answered");
    const r2 = await chatLive("What codename did I give you?", [
      { role: "user", content: "My favorite test codename for this conversation is Phoenix." },
      { role: "assistant", content: r1.text.slice(0, 2000) },
    ]);
    ok(/phoenix/i.test(r2.text), `phoenix: second turn recalls the codename (reply: ${r2.text.slice(0, 80).replace(/\n/g, " ")}…)`);
  }

  // 4. The spec's exact health-check mission reaches a terminal state -------
  console.log("4. full health-check mission reaches a terminal state (unanswered approvals auto-deny)");
  const goal = "Inspect the current ORVYN project and perform a full application health check. First, create a plan before making any changes. Check the project structure, TypeScript configuration, dependencies, build scripts, and application startup flow. Run the appropriate typecheck, tests, and build commands.";
  const res = await fetch(`${LIVE}/api/v1/agent/orchestrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot: repoRoot.replace(/\\/g, "/"), goal }),
  });
  if (!res.ok) {
    ok(false, `mission: orchestrate rejected (${res.status})`);
    return;
  }
  const { runId } = await res.json();

  // 5. Fill the remaining concurrency slots; the NEXT mission must report
  //    itself as queued — truthfully — and a queued mission must be
  //    cancellable before it ever starts.
  console.log("5. queue truthfulness: full slots → run.queued; queued mission cancellable");
  const filler = await fetch(`${LIVE}/api/v1/agent/orchestrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectRoot: repoRoot.replace(/\\/g, "/"),
      goal: "Inspect this repository's apps/backend directory: read its package.json and src/index.ts, and describe the application startup flow in a short paragraph. Read-only — do not run any commands.",
    }),
  });
  const fillerData = await filler.json();
  ok(fillerData.queue?.running >= 2, `filler mission occupies slot 2 (queue: ${JSON.stringify(fillerData.queue)})`);

  const queuedRes = await fetch(`${LIVE}/api/v1/agent/orchestrate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectRoot: repoRoot.replace(/\\/g, "/"), goal: "List the top-level folders and say only their names." }),
  });
  const queuedData = await queuedRes.json();
  const queuedRun = queuedData.runId;
  ok(queuedData.queue?.waiting >= 1, `third mission is queued, not silently 'running' (queue: ${JSON.stringify(queuedData.queue)})`);

  await new Promise((r) => setTimeout(r, 1500));
  const qd = await fetch(`${LIVE}/api/v1/agent/stream/runs/${queuedRun}/events.json`).then((r) => r.json());
  ok(qd.status === "queued", `queued mission: status is '${qd.status}'`);
  ok((qd.events ?? []).some((e) => e.type === "run.queued"), "queued mission: emitted run.queued (renderer can show QUEUED + position)");

  // Cancel it before a slot frees: it must never start executing.
  await fetch(`${LIVE}/api/v1/agent/stream/runs/${queuedRun}/cancel`, { method: "POST" });
  const afterCancel = await runStatus(LIVE, queuedRun);
  ok(afterCancel === "cancelled", `queued mission: cancelled before start (status '${afterCancel}')`);;

  let approvalsDeniedByTimeout = 0;
  const typeCounts = {};
  const started = Date.now();
  const terminal = await consume(LIVE, runId, (ev) => {
    typeCounts[ev.type] = (typeCounts[ev.type] ?? 0) + 1;
    if (ev.type === "approval.resolved" && ev.data.approved === false && ev.data.reason) approvalsDeniedByTimeout++;
  }, 600000).catch((e) => ({ type: "exception", error: String(e) }));
  const status = await runStatus(LIVE, runId);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  ok(["completed", "error", "cancelled"].includes(status), `mission: terminal status '${status}' after ${mins} min (terminal=${terminal?.type})`);
  console.log(`     (received events: ${JSON.stringify(typeCounts)})`);
  console.log(`     (auto-denied approvals: ${approvalsDeniedByTimeout} — the run ended for real, never RUNNING forever)`);
  // The filler is left to finish on its own; it is small and read-only.
}

try {
  await partA();
  await partB();
} finally {
  server.kill();
  // Windows can EPERM on fresh temp dirs still held by the just-killed
  // backend — best-effort cleanup, never fail the run for it.
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
}
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
