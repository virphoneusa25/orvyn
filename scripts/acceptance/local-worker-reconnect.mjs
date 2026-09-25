// scripts/acceptance/local-worker-reconnect.mjs
//
// The desktop's Local Worker must stay running and reconnect by itself when
// the control plane restarts (every deploy restarts it, and the control plane
// keeps workers in memory). Before this was fixed the worker process exited
// right after "ready", and after a restart runs failed with "Local execution
// requires the desktop Local Worker. It is offline".
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/local-worker-reconnect.mjs

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4671;
const BASE = `http://127.0.0.1:${PORT}`;
const KEY = "reconnect-test-key-000000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-rw-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-rw-projects-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; };

function startBackend() {
  const p = spawn(process.execPath, ["dist/index.js"], {
    cwd: backendCwd,
    env: { ...process.env, ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: projectsDir, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_API_KEY: KEY, ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64") },
    stdio: "ignore",
  });
  return p;
}
async function healthy() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {} await sleep(250); }
  throw new Error("backend did not start");
}
async function workerState() {
  const r = await fetch(`${BASE}/api/v1/local-worker/health`, { headers: { "x-api-key": KEY, Authorization: `Bearer ${KEY}` } });
  return (await r.json()).state;
}

let backend = startBackend();
let worker;
try {
  await healthy();
  worker = spawn(process.execPath, ["dist/localWorker/entry.js"], {
    cwd: backendCwd,
    env: { ...process.env, ORVYN_CONTROL_PLANE: BASE, ORVYN_API_KEY: KEY, ORVYN_PROJECT_ROOT: projectsDir },
    stdio: "ignore",
  });
  let exited = false;
  worker.on("exit", () => { exited = true; });
  await sleep(3000);
  ok((await workerState()) === "ready", "the Local Worker registers with the control plane");
  await sleep(4000);
  ok(!exited, "the Local Worker process keeps running after it registers");

  backend.kill();
  await sleep(800);
  backend = startBackend();
  await healthy();
  ok((await workerState()) === "offline", "a restarted control plane has forgotten the worker (expected)");
  let back = false;
  for (let i = 0; i < 20 && !back; i++) { await sleep(1000); back = (await workerState()) === "ready"; }
  ok(back, "the worker reconnects by itself within 20 seconds of the restart");
  ok(!exited, "the worker never exited");
} catch (err) {
  failures++;
  console.error("HARNESS ERROR:", err.message);
} finally {
  worker?.kill();
  backend.kill();
}
console.log(failures === 0 ? "\nLOCAL WORKER RECONNECT: PASS" : `\nLOCAL WORKER RECONNECT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
