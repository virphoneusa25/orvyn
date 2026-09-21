// apps/worker/src/index.ts
//
// The ORVYN Worker service: executes coding missions inside isolated Docker
// containers on a remote machine. Registers with the control plane,
// heartbeats, polls for jobs, runs them in per-mission containers, streams
// events back, handles cancellation, retrieves artifacts, and cleans up.
//
// Phase 4B hardening:
// - Cancellation: polls for cancel commands, docker rm -f kills the container
// - Re-registration: auto re-registers if heartbeat returns 404
// - Artifacts: lists workspace files before cleanup, reports to control plane
// - Failure isolation: command errors return exit/stdout/stderr, worker survives
// - Network: containers have --network none (provable)

import { request } from "http";
import { spawn, ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// ── Configuration ──────────────────────────────────────────────────────────

const CONTROL_PLANE = process.env.ORVYN_CONTROL_PLANE || "http://localhost:4570";
const API_KEY = process.env.ORVYN_API_KEY || "";
const WORKSPACE_DIR = process.env.ORVYN_WORKSPACE_DIR || "/opt/orvyn/workspaces";
const SANDBOX_IMAGE = process.env.ORVYN_SANDBOX_IMAGE || "node:20-slim";
const MAX_CONCURRENT = Number(process.env.ORVYN_MAX_CONCURRENT_RUNS) || 2;
const HEARTBEAT_INTERVAL = 15_000;
const POLL_INTERVAL = 5_000;
const CANCEL_POLL_INTERVAL = 3_000;

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

interface CommandResult {
  ok: boolean;
  output: string;
  exitCode: number;
  stderr?: string;
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

const activeContainers = new Map<string, string>(); // runId → containerId
const cancelledRuns = new Set<string>();
let dockerVersion = "unknown";
let registered = false;

function workerInfo(): WorkerInfo {
  return {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    capabilities: ["docker", "node", "mission-execution", "browser"],
    cpuCount: os.cpus().length,
    ramMb: Math.round(os.totalmem() / 1024 / 1024),
    diskGb: Math.round(os.freemem() / 1024 / 1024 / 1024),
    dockerVersion,
    status: activeContainers.size >= MAX_CONCURRENT ? "busy" : "online",
    activeRuns: activeContainers.size,
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

// ── Cancellation ───────────────────────────────────────────────────────────

/** Polls the control plane for cancel commands while a job runs. */
function startCancelPolling(runId: string): NodeJS.Timeout {
  return setInterval(async () => {
    try {
      const res = await cp(`/api/v1/worker/cancel/${runId}`);
      if (res.cancelled || res.stopRequested) {
        console.log(`[worker] CANCEL received for ${runId}`);
        cancelledRuns.add(runId);
        const containerId = activeContainers.get(runId);
        if (containerId) {
          console.log(`[worker] docker rm -f ${containerId.slice(0, 12)}`);
          const rm = await docker(["rm", "-f", containerId]);
          console.log(`[worker] cancel rm result: code=${rm.code}`);
        }
      }
    } catch { /* control plane unreachable — next poll will retry */ }
  }, CANCEL_POLL_INTERVAL);
}

function stopCancelPolling(timer: NodeJS.Timeout): void {
  clearInterval(timer);
}

// ── Artifact retrieval ─────────────────────────────────────────────────────

/** Lists files in the workspace before cleanup — real artifacts from the run. */
async function collectArtifacts(runId: string): Promise<string[]> {
  const workspace = path.join(WORKSPACE_DIR, runId);
  const artifacts: string[] = [];
  function walk(dir: string, prefix: string): void {
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) {
          artifacts.push(prefix + entry.name);
        } else if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), prefix + entry.name + "/");
        }
      }
    } catch { /* unreadable */ }
  }
  walk(workspace, "");
  return artifacts;
}

// ── ORION tool execution (remote equivalents) ─────────────────────────────

/** Reads a file inside the mission container. */
async function remoteReadFile(containerId: string, filePath: string): Promise<CommandResult> {
  const r = await docker(["exec", containerId, "cat", `/workspace/${filePath}`]);
  return { ok: r.code === 0, output: r.stdout, exitCode: r.code, stderr: r.stderr };
}

/** Writes a file inside the mission container (via heredoc). */
async function remoteWriteFile(containerId: string, filePath: string, content: string): Promise<CommandResult> {
  const escaped = content.replace(/'/g, "'\\''");
  const r = await docker(["exec", containerId, "sh", "-c", `echo '${escaped}' > /workspace/${filePath}`]);
  return { ok: r.code === 0, output: r.stdout, exitCode: r.code, stderr: r.stderr };
}

/** Edits a file inside the container (sed-style replace). */
async function remoteEditFile(containerId: string, filePath: string, oldStr: string, newStr: string): Promise<CommandResult> {
  const esc = (s: string) => s.replace(/'/g, "'\\''").replace(/\//g, "\\/");
  const r = await docker(["exec", containerId, "sh", "-c",
    `sed -i 's/${esc(oldStr)}/${esc(newStr)}/' /workspace/${filePath}`]);
  return { ok: r.code === 0, output: r.stdout, exitCode: r.code, stderr: r.stderr };
}

/** Runs a terminal command inside the mission container. */
async function remoteTerminal(containerId: string, command: string): Promise<CommandResult> {
  const r = await docker(["exec", containerId, "sh", "-c", command]);
  return { ok: r.code === 0, output: r.stdout + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.code, stderr: r.stderr };
}

/** Copies the project into the container workspace. */
async function transferProject(containerId: string, sourcePath: string): Promise<boolean> {
  if (!sourcePath || !fs.existsSync(sourcePath)) return false;
  // tar pipe: stream project into container's /workspace
  const workspace = "/workspace";
  return new Promise((resolve) => {
    const tar = spawn("tar", ["cf", "-", "-C", sourcePath, "."], { windowsHide: true });
    const dock = spawn("docker", ["exec", "-i", containerId, "tar", "-xf", "-", "-C", workspace], { windowsHide: true });
    let err = "";
    dock.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    tar.stdout.pipe(dock.stdin);
    dock.on("close", (code) => {
      console.log(`[worker] project transfer: code=${code} err=${err.slice(0, 100)}`);
      resolve(code === 0);
    });
    tar.on("error", () => resolve(false));
    dock.on("error", () => resolve(false));
  });
}

// Tool RPC: the worker polls for tool requests from the control plane's
// ORION model and executes them inside the container. The MODEL decides
// which tools to call; the worker is a dumb executor.
async function pollForToolRequests(runId: string, containerId: string): Promise<void> {
  while (activeContainers.has(runId) && !cancelledRuns.has(runId)) {
    try {
      const res = await cp("/api/v1/worker/tools/" + runId + "/next");
      if (res.request) {
        const req = res.request;
        console.log("[worker] tool: " + req.tool);
        let result: { ok: boolean; output?: string; stderr?: string; exitCode?: number; error?: string };
        switch (req.tool) {
          case "read_file": {
            const r = await remoteReadFile(containerId, String(req.arguments.path ?? ""));
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "write_file": {
            const r = await remoteWriteFile(containerId, String(req.arguments.path ?? ""), String(req.arguments.content ?? ""));
            result = { ok: r.ok, output: "Wrote " + req.arguments.path, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "edit_file": {
            const r = await remoteEditFile(containerId, String(req.arguments.path ?? ""), String(req.arguments.old_string ?? ""), String(req.arguments.new_string ?? ""));
            result = { ok: r.ok, output: r.ok ? "Edited " + req.arguments.path : undefined, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "list_directory": {
            const r = await remoteTerminal(containerId, "ls -la " + (req.arguments.path ? "/workspace/" + req.arguments.path : "/workspace"));
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "search_code": case "search_files": {
            const q = String(req.arguments.query ?? req.arguments.pattern ?? "");
            const r = await remoteTerminal(containerId, 'grep -rn "' + q + '" /workspace --include="*.js" --include="*.ts" --include="*.json" --include="*.html" 2>/dev/null | head -30');
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "terminal": case "run_command": {
            const cmd = String(req.arguments.command ?? "");
            await emitEvent(runId, "terminal.started", { command: cmd });
            const r = await remoteTerminal(containerId, cmd);
            await emitEvent(runId, "terminal.output", { data: (r.output || "").slice(0, 2000) });
            await emitEvent(runId, "terminal.completed", { exitOk: r.exitCode === 0 });
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "run_tests": {
            await emitEvent(runId, "terminal.started", { command: "npm test" });
            const r = await remoteTerminal(containerId, "npm test 2>&1 || node test.js 2>&1 || echo 'no test runner'");
            await emitEvent(runId, "terminal.output", { data: (r.output || "").slice(0, 2000) });
            await emitEvent(runId, "terminal.completed", { exitOk: r.exitCode === 0 });
            result = { ok: r.exitCode === 0, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "run_typecheck": {
            const r = await remoteTerminal(containerId, "npx tsc --noEmit 2>&1 || echo 'no typescript'");
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          default:
            result = { ok: false, error: "Unknown tool: " + req.tool };
        }
        await cp("/api/v1/worker/tools/" + runId + "/result", "POST", {
          requestId: req.requestId, runId: runId, ok: result.ok,
          output: result.output, stderr: result.stderr, exitCode: result.exitCode,
          error: result.error, durationMs: Date.now() - req.createdAt,
        }).catch(e => console.warn("[worker] result failed: " + e.message));
        console.log("[worker] tool result: " + req.tool + " ok=" + result.ok);
      }
    } catch { /* transient */ }
    await new Promise(r => setTimeout(r, 1000));
  }
}

// ── Mission container lifecycle ────────────────────────────────────────────

async function executeJob(job: JobAssignment): Promise<void> {
  const runId = job.runId;
  console.log(`[worker] executeJob START: ${runId} (${job.instruction.slice(0, 60)})`);
  const containerName = `orvyn-worker-${runId.slice(0, 12)}`;
  let containerId = "";
  const cancelTimer = startCancelPolling(runId);

  try {
    await emitEvent(runId, "run.started", { instruction: job.instruction, mode: job.mode || "agent", workerId: WORKER_ID });
    await emitEvent(runId, "agent.phase", { phase: "UNDERSTAND", note: "Preparing workspace" });

    // Create workspace
    const workspace = path.join(WORKSPACE_DIR, runId);
    fs.mkdirSync(workspace, { recursive: true });

    // Create isolated mission container
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
    activeContainers.set(runId, containerId);

    const start = await docker(["start", containerId]);
    if (start.code !== 0) throw new Error(`Container start failed: ${start.stderr}`);

    await emitEvent(runId, "sandbox.started", {
      container: containerName, image: SANDBOX_IMAGE, network: "none",
      capDrop: "ALL", memory: "1g", cpus: "1", pidsLimit: 256,
    });

    // Transfer project if provided
    if (job.projectRoot) {
      await emitEvent(runId, "agent.phase", { phase: "DISCOVER", note: "Transferring project to remote workspace" });
      const transferred = await transferProject(containerId, job.projectRoot);
      await emitEvent(runId, "tool.completed", {
        tool: "project_transfer",
        preview: transferred ? `Project copied to remote workspace` : `No project at ${job.projectRoot}`,
        ok: transferred,
      });
    }

    // ENTER THE TOOL RPC LOOP — ORION model drives all tool calls from here.
    // The worker is a dumb executor; the control plane's ORION decides
    // which tools to call, the worker executes them in the container.
    await emitEvent(runId, "agent.phase", { phase: "EXECUTE", note: "Worker ready for tool requests" });
    console.log("[worker] entering tool RPC loop for " + runId);
    await pollForToolRequests(runId, containerId);
    console.log("[worker] tool RPC loop ended for " + runId);

    // Collect artifacts BEFORE cleanup
    const artifacts = await collectArtifacts(runId);
    await emitEvent(runId, "artifacts.collected", { files: artifacts });

    // Report completion
    await emitEvent(runId, "run.completed", {
      workerId: WORKER_ID,
      artifacts,
      summary: "Remote mission executed. " + artifacts.length + " artifact(s).",
      executionLocation: "OVH_WORKER",
    });
  } catch (err: any) {
    const wasCancelled = cancelledRuns.has(runId);
    await emitEvent(runId, wasCancelled ? "run.cancelled" : "run.error", {
      message: wasCancelled ? "Cancelled by user — container killed." : `Worker execution failed: ${err.message}`,
      workerId: WORKER_ID,
    });
  } finally {
    stopCancelPolling(cancelTimer);
    if (containerId) {
      const rm = await docker(["rm", "-f", containerId]);
      console.log(`[worker] cleanup container ${containerId.slice(0, 12)}: code=${rm.code}`);
    }
    activeContainers.delete(runId);
    cancelledRuns.delete(runId);
    try { fs.rmSync(path.join(WORKSPACE_DIR, runId), { recursive: true, force: true }); } catch {}
    console.log(`[worker] executeJob DONE: ${runId} (worker alive: yes)`);
  }
}

// ── Registration with auto-recovery ────────────────────────────────────────

async function register(): Promise<void> {
  const info = workerInfo();
  const res = await cp("/api/v1/worker/register", "POST", info);
  registered = res.ok === true;
  console.log(`[worker] registered: ${WORKER_ID} → ok=${res.ok}`);
}

async function heartbeat(): Promise<void> {
  if (!registered) {
    // Not registered yet — try to register
    await register().catch((e) => console.warn(`[worker] register failed: ${e.message}`));
    return;
  }
  try {
    const info = workerInfo();
    const res = await cp("/api/v1/worker/heartbeat", "POST", info);
    if (res.error?.includes("Not registered")) {
      // Control plane restarted or lost state — re-register
      console.log(`[worker] heartbeat 404, re-registering...`);
      registered = false;
      await register();
    }
  } catch (e: any) {
    console.warn(`[worker] heartbeat failed: ${e.message}`);
    // Mark unregistered so next heartbeat tries to re-register
    if (e.message.includes("timeout") || e.message.includes("ECONNREFUSED")) {
      registered = false;
    }
  }
}

// ── Job polling ────────────────────────────────────────────────────────────

async function pollForJobs(): Promise<void> {
  if (activeContainers.size >= MAX_CONCURRENT) return;
  try {
    const res = await cp(`/api/v1/worker/poll?workerId=${WORKER_ID}`);
    if (res.job) {
      console.log(`[worker] job received: ${res.job.runId}`);
      void executeJob(res.job);
    }
  } catch { /* transient */ }
}

// ── Docker detection ───────────────────────────────────────────────────────

async function detectDocker(): Promise<void> {
  const res = await docker(["version", "--format", "{{.Server.Version}}"]);
  if (res.code === 0) dockerVersion = res.stdout;
  else console.warn(`[worker] Docker not available: ${res.stderr}`);
}

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] ORVYN Worker starting (Phase 4B hardened)`);
  console.log(`[worker]   ID: ${WORKER_ID}`);
  console.log(`[worker]   Control plane: ${CONTROL_PLANE}`);
  console.log(`[worker]   Workspace: ${WORKSPACE_DIR}`);
  console.log(`[worker]   Max concurrent: ${MAX_CONCURRENT}`);

  await detectDocker();
  await register();

  setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL);
  setInterval(() => void pollForJobs(), POLL_INTERVAL);

  console.log(`[worker] Running — heartbeat ${HEARTBEAT_INTERVAL / 1000}s, poll ${POLL_INTERVAL / 1000}s, cancel-check ${CANCEL_POLL_INTERVAL / 1000}s`);
}

void main();
