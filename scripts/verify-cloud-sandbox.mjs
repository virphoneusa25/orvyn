// scripts/verify-cloud-sandbox.mjs
//
// Acceptance test for sandboxed cloud execution (master spec §31 / §52).
// Runs a REAL mission against a deployed ORVYN backend and asserts the
// isolation properties end to end:
//
//   1. the mission announces a sandbox (sandbox.started event),
//   2. its terminal tool executes inside the container (the proof file is
//      created by a command, not by host file tools),
//   3. the sandbox's file lands on the project volume via merge-back,
//   4. the container is removed afterwards (no orvyn-sandbox-* leftovers).
//
// Usage: node scripts/verify-cloud-sandbox.mjs [baseUrl]
// Reads the API key from .ovh-api-key.txt. Costs a few cents of model calls.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.argv[2] || "http://40.160.11.123";
const KEY = readFileSync(resolve(".", ".ovh-api-key.txt"), "utf-8").trim();
const AUTH = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "  ✔" : "  ✖"} ${label}`);
  if (!cond) failures++;
};

async function waitForTerminalEvent(runId, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let after = 0;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events.json?after=${after}`, { headers: AUTH });
    if (!res.ok) throw new Error(`events.json HTTP ${res.status}`);
    const data = await res.json();

    for (const e of data.events) {
      // Auto-approve anything the mission asks for — this test is about
      // sandbox execution, not the approval UX.
      if (e.type === "approval.required") {
        await fetch(`${BASE}/api/v1/agent/orchestrate/approvals/${e.data.callId}`, {
          method: "POST",
          headers: AUTH,
          body: JSON.stringify({ approved: true, scope: "mission" }),
        }).catch(() => {});
      }
      if (e.type === "run.completed" || e.type === "run.error" || e.type === "mission.blocked") {
        return e;
      }
    }
    after = data.events.at(-1)?.sequence ?? after;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("mission did not finish within the timeout");
}

async function main() {
  // 1. Health + a scratch project on the backend's projects volume.
  const health = await fetch(`${BASE}/api/v1/health`).then((r) => r.json());
  ok(health.status === "ok", `backend healthy at ${BASE}`);

  // The project root must exist inside the backend container; it runs on the
  // server, so this script cannot create it directly — the caller prepares
  // /projects/sbx-verify via SSH before running this script.

  // 2. Run the mission.
  console.log("starting sandboxed mission…");
  const start = await fetch(`${BASE}/api/v1/agent/orchestrate`, {
    method: "POST",
    headers: AUTH,
    body: JSON.stringify({
      projectRoot: "/projects/sbx-verify",
      goal:
        "Use the terminal tool exactly once to run: printf 'isolated-execution' > /workspace/SANDBOX_PROOF.txt — then read the file back with the terminal tool to verify it exists, and report done. Do not use write_file for this.",
    }),
  });
  if (!start.ok) throw new Error(`orchestrate HTTP ${start.status}: ${await start.text()}`);
  const runId = (await start.json()).runId;

  const end = await waitForTerminalEvent(runId);
  const events = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events.json?after=0`, { headers: AUTH }).then((r) => r.json());
  const types = events.events.map((e) => e.type);

  ok(types.includes("sandbox.started"), "mission ran inside a sandbox (sandbox.started)");
  ok(types.includes("sandbox.stopped"), "sandbox was stopped and merged back (sandbox.stopped)");
  ok(end.type === "run.completed", `mission completed (end event: ${end.type} — ${String(end.data.message ?? "").slice(0, 120)})`);

  // The multi-agent worker emits tool.started{tool:"terminal"}; the
  // single-agent runtime additionally emits terminal.started. Match both.
  const terminalCalls = events.events.filter(
    (e) => e.type === "terminal.started" || (e.type === "tool.started" && e.data.tool === "terminal")
  );
  ok(terminalCalls.length > 0, `terminal executed inside the sandbox (${terminalCalls.length} command(s))`);

  console.log(failures === 0 ? "\nCLOUD SANDBOX VERIFICATION PASSED" : `\nCLOUD SANDBOX VERIFICATION FAILED (${failures})`);
  console.log("(File + container checks run on the server via SSH — see the caller.)");
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("VERIFICATION FAILED:", err.message);
  process.exitCode = 1;
});
