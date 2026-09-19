// scripts/smoke-agent.mjs
//
// End-to-end smoke test for the agent pipeline, runnable with zero external
// dependencies: boots the built backend with a scratch data dir and every API
// key neutralised, so ModelService seeds the mock model and the scripted
// agent demo drives a real HTTP run. Verifies the pieces that only prove
// themselves over the wire — not in unit tests:
//
//   1. a write approval arrives WITH a diff preview,
//   2. approving it lands the file and emits file.edit with the preview,
//   3. cancelling a live run ends it as "cancelled", not "error".
//
// Usage: node scripts/smoke-agent.mjs   (run after `npm run build`)

import { spawn, execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4599;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

const dataDir = mkdtempSync(join(tmpdir(), "orvyn-smoke-data-"));
const projectDir = mkdtempSync(join(tmpdir(), "orvyn-smoke-project-"));
writeFileSync(join(projectDir, "hello.txt"), "hello smoke\n");
// Checkpoints (and therefore Undo) are built on git status — a bare folder
// has no undo. Real projects are repos; make the fixture one too.
execSync("git init -q", { cwd: projectDir });

// Empty-string env vars beat loadEnv's `=== undefined` check, so the real
// .env keys stay neutralised and the mock model is the only provider.
// (MODEL_API_KEY, not OPENAI_API_KEY, is what activates the OpenAI seed.)
const keyVars = [
  "ORVYN_API_KEY", "MODEL_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY",
  "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY",
  "OLLAMA_MODEL", "ASTRA_MODEL_ID", "ORCHESTRATOR_MODEL",
].reduce((acc, k) => ({ ...acc, [k]: "" }), {});

const server = spawn(process.execPath, ["dist/index.js"], {
  cwd: join(repoRoot, "apps", "backend"),
  env: { ...process.env, ...keyVars, ORVYN_DATA_DIR: dataDir, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✔" : "  ✖"} ${label}`);
  if (!cond) failures++;
};

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/v1/health`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("backend did not become healthy");
}

/** Consumes a run's SSE stream until a terminal event, invoking onEvent. */
async function consume(runId, onEvent, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const seen = [];
  const res = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r({ value: undefined, done: true }), deadline - Date.now())),
    ]);
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const event = JSON.parse(line.slice(5));
      seen.push(event);
      if (onEvent(event)) return event;
    }
  }
  const dump = seen.map((e) => `${e.type} ${JSON.stringify(e.data).slice(0, 160)}`).join("\n  ");
  throw new Error(`stream ended without the expected event. Events seen:\n  ${dump || "(none)"}`);
}

async function main() {
  await waitForHealth();
  console.log("backend healthy — starting agent run");

  // --- Run 1: approval carries a diff preview, then the edit lands ---
  let runId;
  {
    const res = await fetch(`${BASE}/api/v1/agent/stream/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectDir, instruction: "smoke test the agent", mode: "agent" }),
    });
    runId = (await res.json()).runId;
  }

  const approval = await consume(
    runId,
    (e) => e.type === "approval.required",
  );
  console.log("run 1: approval arrived");
  ok(approval.data.tool === "write_file", "approval is for write_file (mock demo step 2)");
  ok(
    approval.data.preview?.kind === "create" && Array.isArray(approval.data.preview?.diff),
    "approval carries a diff preview the user can actually read"
  );
  ok(
    JSON.stringify(approval.data.preview?.diff ?? "").includes("Agent run"),
    "the preview diff contains the proposed content"
  );

  const approveRes = await fetch(`${BASE}/api/v1/agent/stream/approvals/${approval.data.callId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ approved: true, scope: "once" }),
  });
  ok(approveRes.ok, "approval accepted by the backend");

  let sawEditPreview = false;
  let sawCheckpoint = false;
  await consume(
    runId,
    (e) => {
      if (e.type === "file.edit" && e.data.preview?.diff) sawEditPreview = true;
      if (e.type === "checkpoint.created") sawCheckpoint = true;
      return e.type === "run.completed";
    },
  );
  ok(sawEditPreview, "file.edit event carries the diff preview");
  ok(sawCheckpoint, "a pre-run snapshot was taken (powers Undo)");
  ok(existsSync(join(projectDir, "AGENT_NOTES.md")), "the approved file was actually written");
  ok(
    readFileSync(join(projectDir, "AGENT_NOTES.md"), "utf8").includes("mock"),
    "the written file has the mock model's content"
  );

  // --- Undo: the run's changes vanish, pre-existing files stay ---
  const undoRes = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/undo`, { method: "POST" });
  const undo = await undoRes.json();
  ok(undoRes.ok, `undo succeeds (${undo.error ?? "restored " + (undo.restored ?? []).length + ", removed " + (undo.removed ?? []).length})`);
  ok(!existsSync(join(projectDir, "AGENT_NOTES.md")), "undo deleted the file the run created");
  ok(existsSync(join(projectDir, "hello.txt")), "undo kept the pre-existing file");

  // --- Feedback is accepted ---
  const fbRes = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "up" }),
  });
  ok(fbRes.ok, "run feedback accepted");

  // --- Run 2: cancel a live run ---
  let runId2;
  {
    const res = await fetch(`${BASE}/api/v1/agent/stream/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot: projectDir, instruction: "cancel me mid-flight", mode: "agent" }),
    });
    runId2 = (await res.json()).runId;
  }

  // Wait until the model is mid-stream (the mock streams word by word), then stop.
  let sawThinking = false;
  await consume(runId2, (e) => {
    if (e.type === "thinking") sawThinking = true;
    return sawThinking && e.type === "message.delta";
  }).catch(() => {}); // timing-dependent; proceed to cancel regardless

  const cancelRes = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId2}/cancel`, { method: "POST" });
  ok((await cancelRes.json()).ok === true, "cancel endpoint reports success");

  const finalEvent = await consume(
    runId2,
    (e) => e.type === "run.cancelled" || e.type === "run.error" || e.type === "run.completed",
  );
  ok(finalEvent.type === "run.cancelled", `run ends as run.cancelled (got ${finalEvent.type})`);

  const statusRes = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId2}/events.json?after=0`);
  ok((await statusRes.json()).status === "cancelled", "run status reads back as cancelled");
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nSMOKE PASSED" : `\nSMOKE FAILED (${failures} assertion(s))`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error("\nSMOKE FAILED:", err.message);
    process.exitCode = 1;
  })
  .finally(() => {
    server.kill();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });
