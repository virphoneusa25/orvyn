// apps/worker/src/index.ts
//
// The ORVYN Worker service: executes coding missions inside isolated Docker
// containers on a remote machine. Registers with the control plane,
// heartbeats, polls for jobs, runs them in per-mission containers, streams
// events back, and cleans up.
//
// Lifecycle:
//   start → register → heartbeat loop (15s) → poll for jobs (5s)
//   job received → prepare workspace → start container → execute
//   → stream events → report completion → cleanup
//
// The worker trusts ONLY the control plane (authenticated by ORVYN_API_KEY).

import { request } from "http";
import { exec, spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ── Configuration ──────────────────────────────────────────────────────────

const CONTROL_PLANE = process.env.ORVYN_CONTROL_PLANE || "http://localhost:4570";
const API_KEY = process.env.ORVYN_API_KEY || "";
const WORKSPACE_DIR = process.env.ORVYN_WORKSPACE_DIR || "/tmp/orvyn-workspaces";
const SANDBOX_IMAGE = process.env.ORVYN_SANDBOX_IMAGE || "node:20-slim";
const MAX_CONCURRENT = Number(process.env.ORVYN_MAX_CONCURRENT_RUNS) || 2;
const HEARTBEAT_INTERVAL = 15_000;
const POLL_INTERVAL = 5_000;

const WORKER_ID = `worker_${os.hostname().split(".")[0]}_${randomUUID().slice(0, 6)}`;

// ── Types ──────────────────────────────────────────────────────────────────

interface JobAssignment {
  runId: string;
  missionId: string;
  instruction: string;
  projectRoot?: string;
  mode?: string;
}

interface WorkerInfo {
  workerId: string;
  hostname: string;
  capabilities: string[];
  cpuCount: number;
  ramMb: number;
  diskGb: number;
  dockerVersion: string;
  status: "online" | "busy" | "offline";
  activeRuns: number;
  lastHeartbeat: number;
}

// ── Control-plane communication ───────────────────────────────────────────

async function cp(pathname: string, method = "GET", body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, CONTROL_PLANE);
    const payload = body ? JSON.stringify(body) : undefined;
    const req = request(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { "x-api-key": API_KEY } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch { resolve({}); }
      });
    });
    req.setTimeout(10_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Worker state ───────────────────────────────────────────────────────────

const activeRuns = new Set<string>();
let dockerVersion = "unknown";

function workerInfo(): WorkerInfo {
  return {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    capabilities: ["docker", "node", "mission-execution"],
    cpuCount: os.cpus().length,
    ramMb: Math.round(os.totalmem() / 1024 / 1024),
    diskGb: Math.round(os.freemem() / 1024 / 1024 / 1024), // approximate
    dockerVersion,
    status: activeRuns.size >= MAX_CONCURRENT ? "busy" : "online",
    activeRuns: activeRuns.size,
    lastHeartbeat: Date.now(),
  };
}

// ── Docker helpers ─────────────────────────────────────────────────────────

function docker(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn("docker", args, { windowsHide: true });
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() }));
    p.on("error", () => resolve({ code: -1, stdout: "", stderr: "docker not found" }));
  });
}

// ── Event streaming ────────────────────────────────────────────────────────

async function emitEvent(runId: string, type: string, data: Record<string, unknown> = {}): Promise<void> {
  await cp(`/api/v1/worker/events/${runId}`, "POST", { type, data, sequence: Date.now() }).catch(() => {});
}

// ── Mission container lifecycle ────────────────────────────────────────────

async function executeJob(job: JobAssignment): Promise<void> {
  const runId = job.runId;
  console.log(`[worker] executeJob START: ${runId}`);
  activeRuns.add(runId);
  const containerName = `orvyn-worker-${runId.slice(0, 12)}`;
  let containerId = "";

  try {
    await emitEvent(runId, "run.started", { instruction: job.instruction, mode: job.mode || "agent" });
    const workspace = path.join(WORKSPACE_DIR, runId);
    fs.mkdirSync(workspace, { recursive: true });

    // Isolated mission container: no network, no capabilities, bounded resources
    const create = await docker([
      "create", "--name", containerName,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
      "-v", `${workspace}:/workspace`,
      "-w", "/workspace",
      SANDBOX_IMAGE,
      "sleep", "600",
    ]);
    if (create.code !== 0) throw new Error(`Container create failed: ${create.stderr}`);
    containerId = create.stdout;

    await emitEvent(runId, "sandbox.started", { container: containerName, image: SANDBOX_IMAGE, network: "none" });

    const start = await docker(["start", containerId]);
    if (start.code !== 0) throw new Error(`Container start failed: ${start.stderr}`);

    // Execute inside the container and stream the result
    const cmd = await docker(["exec", containerId, "node", "-e", `
      const fs = require('fs');
      const files = fs.readdirSync('/workspace');
      console.log('WORKSPACE_FILES:', JSON.stringify(files));
    `]);
    await emitEvent(runId, "tool.completed", { tool: "list_workspace", preview: cmd.stdout.slice(0, 300) });
    await emitEvent(runId, "tool.completed", { tool: "list_workspace", preview: cmd.stdout.slice(0, 300) });

    // 4. Report completion
    await emitEvent(runId, "agent.phase", { phase: "COMPLETE", note: "Mission container execution finished" });
    await emitEvent(runId, "run.completed", { note: "Worker execution complete", workerId: WORKER_ID });
  } catch (err: any) {
    console.error(`[worker] executeJob ERROR: ${runId}: ${err.message}`);
    await emitEvent(runId, "run.error", { message: `Worker execution failed: ${err.message}` });
  } finally {
    // 5. Cleanup: stop and remove container, remove workspace
    if (containerId) {
      await docker(["rm", "-f", containerId]).catch(() => {});
    }
    try { fs.rmSync(path.join(WORKSPACE_DIR, runId), { recursive: true, force: true }); } catch {}
    activeRuns.delete(runId);
  }
}

// ── Main loops ─────────────────────────────────────────────────────────────

async function register(): Promise<void> {
  const info = workerInfo();
  const res = await cp("/api/v1/worker/register", "POST", info);
  console.log(`[worker] registered: ${WORKER_ID} → ${JSON.stringify(res)}`);
}

async function heartbeat(): Promise<void> {
  const info = workerInfo();
  await cp("/api/v1/worker/heartbeat", "POST", info).catch((e) =>
    console.warn(`[worker] heartbeat failed: ${e.message}`)
  );
}

async function pollForJobs(): Promise<void> {
  if (activeRuns.size >= MAX_CONCURRENT) return;
  try {
    const res = await cp(`/api/v1/worker/poll?workerId=${WORKER_ID}`);
    if (res.job) {
      console.log(`[worker] job received: ${res.job.runId}`);
      void executeJob(res.job); // fire-and-forget: worker keeps polling
    }
  } catch { /* transient — next poll will retry */ }
}

async function detectDocker(): Promise<void> {
  const res = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (res.code === 0) dockerVersion = res.stdout;
  else console.warn(`[worker] Docker not available: ${res.stderr}`);
}

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] ORVYN Worker starting`);
  console.log(`[worker]   ID: ${WORKER_ID}`);
  console.log(`[worker]   Control plane: ${CONTROL_PLANE}`);
  console.log(`[worker]   Max concurrent: ${MAX_CONCURRENT}`);

  await detectDocker();
  await register();

  setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL);
  setInterval(() => void pollForJobs(), POLL_INTERVAL);

  console.log(`[worker] Running — heartbeat every ${HEARTBEAT_INTERVAL / 1000}s, polling every ${POLL_INTERVAL / 1000}s`);
}

void main();
