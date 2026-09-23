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
const POLL_INTERVAL = 2_000;
const CANCEL_POLL_INTERVAL = 3_000;
/** Mission container lifetime ceiling — long enough for approval waits. */
const CONTAINER_LIFETIME_S = Number(process.env.ORVYN_CONTAINER_LIFETIME_S) || 3600;

const WORKER_ID = `worker_${os.hostname().split(".")[0]}_${randomUUID().slice(0, 6)}`;

// ── Types ──────────────────────────────────────────────────────────────────

interface JobAssignment {
  runId: string;
  missionId: string;
  instruction: string;
  projectRoot?: string;
  mode?: string;
  tenantId?: string;
  organizationId?: string;
  userId?: string;
  projectId?: string | null;
  workspace?: string;
  identity?: {
    tenantId: string;
    organizationId: string;
    userId: string;
    projectId: string | null;
    runId: string;
  } | null;
  /**
   * "executor": prepare the mission container and serve tool RPC requests.
   * The control-plane ORION model drives ALL tool decisions; this worker
   * never decides what to run and NEVER emits run.completed.
   */
  role?: "executor";
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
const jobIdentity = new Map<string, JobAssignment>();
const cancelledRuns = new Set<string>();

function sanitizeSegment(raw: string): string {
  const value = String(raw ?? "").trim();
  if (!value || value.includes("\0") || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error("invalid mission path segment");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new Error("invalid mission path segment");
  return value;
}

function trustedJob(job: JobAssignment): JobAssignment {
  const tenantId = job.identity?.tenantId || job.tenantId;
  if (!tenantId) throw new Error("control plane omitted tenantId — worker will not invent one");
  sanitizeSegment(tenantId);
  sanitizeSegment(job.runId);
  return { ...job, tenantId };
}

function workspaceFor(job: JobAssignment): string {
  if (job.workspace) {
    const resolved = path.resolve(job.workspace);
    const root = path.resolve(WORKSPACE_DIR);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error("workspace escapes worker root");
    }
    return resolved;
  }
  return path.join(WORKSPACE_DIR, sanitizeSegment(job.tenantId || ""), sanitizeSegment(job.runId));
}
let dockerVersion = "unknown";
let registered = false;

function workerInfo(): WorkerInfo {
  return {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    capabilities: ["docker", "node", "mission-execution", "browser", "desktop"],
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
  const job = jobIdentity.get(runId);
  await cp(`/api/v1/worker/events/${runId}`, "POST", {
    type,
    data,
    sequence: Date.now(),
    tenantId: job?.tenantId,
    organizationId: job?.organizationId,
    userId: job?.userId,
    runId,
  }).catch(() => {});
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
  const job = jobIdentity.get(runId);
  const workspace = job ? workspaceFor(job) : path.join(WORKSPACE_DIR, "_unknown", runId);
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
//
// File tools operate on the mission workspace directory — the SAME directory
// bind-mounted into the container at /workspace, so every mutation is visible
// to the container immediately (it IS the container's filesystem). Exact
// string semantics match the control-plane's local edit_file so the model
// sees identical behavior local or remote. Commands (terminal, tests,
// search) execute INSIDE the container via docker exec.

/** Resolves a workspace-relative path, refusing escapes. */
function workspacePath(runId: string, relative: string): string | null {
  const job = jobIdentity.get(runId);
  if (!job) return null;
  const clean = String(relative ?? "").replace(/^[/\\]+/, "");
  const base = workspaceFor(job);
  const resolved = path.resolve(base, clean);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/** Reads a file from the mission workspace (the container's /workspace). */
async function remoteReadFile(runId: string, filePath: string): Promise<CommandResult> {
  const target = workspacePath(runId, filePath);
  if (!target) return { ok: false, output: "", exitCode: 1, stderr: "path escapes the workspace" };
  try {
    const content = fs.readFileSync(target, "utf8");
    return { ok: true, output: content, exitCode: 0 };
  } catch (e: any) {
    return { ok: false, output: "", exitCode: 1, stderr: e.code === "ENOENT" ? `File not found: ${filePath}` : e.message };
  }
}

/** Writes a file into the mission workspace (binary-safe, no shell quoting). */
async function remoteWriteFile(runId: string, filePath: string, content: string): Promise<CommandResult> {
  const target = workspacePath(runId, filePath);
  if (!target) return { ok: false, output: "", exitCode: 1, stderr: "path escapes the workspace" };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
    const bytesWritten = Buffer.byteLength(content, "utf8");
    return {
      ok: true,
      output: JSON.stringify({ ok: true, path: filePath, bytesWritten }),
      exitCode: 0,
    };
  } catch (e: any) {
    return { ok: false, output: "", exitCode: 1, stderr: e.message };
  }
}

/**
 * Exact find/replace edit — same semantics as the control-plane edit_file:
 * old_string must match exactly once unless replace_all is true.
 */
async function remoteEditFile(runId: string, filePath: string, oldStr: string, newStr: string, replaceAll: boolean): Promise<CommandResult> {
  const target = workspacePath(runId, filePath);
  if (!target) return { ok: false, output: "", exitCode: 1, stderr: "path escapes the workspace" };
  if (!oldStr) return { ok: false, output: "", exitCode: 1, stderr: "old_string must not be empty" };
  try {
    const content = fs.readFileSync(target, "utf8");
    const count = content.split(oldStr).length - 1;
    if (count === 0) return { ok: false, output: "", exitCode: 1, stderr: "old_string not found in " + filePath };
    if (count > 1 && !replaceAll) {
      return { ok: false, output: "", exitCode: 1, stderr: "old_string matched " + count + " times in " + filePath + ". Pass replace_all=true or include more surrounding context to make it unique." };
    }
    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    fs.writeFileSync(target, updated, "utf8");
    return { ok: true, output: "Edited " + filePath, exitCode: 0 };
  } catch (e: any) {
    return { ok: false, output: "", exitCode: 1, stderr: e.code === "ENOENT" ? `File not found: ${filePath}` : e.message };
  }
}

/** Runs a terminal command INSIDE the mission container. */
async function remoteTerminal(containerId: string, command: string): Promise<CommandResult> {
  const r = await docker(["exec", containerId, "sh", "-c", command]);
  return { ok: r.code === 0, output: r.stdout + (r.stderr ? "\n" + r.stderr : ""), exitCode: r.code, stderr: r.stderr };
}

/** Shell-safely quotes one argument for sh -c interpolation. */
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/**
 * Runs the project's test suite INSIDE the container. The only decision the
 * worker makes is WHICH generic runner applies: npm test when package.json
 * declares a test script. Otherwise it reports honestly and the MODEL picks
 * the command with the terminal tool — the worker never hardcodes a project's
 * test file.
 */
async function remoteRunTests(runId: string, containerId: string): Promise<CommandResult> {
  const pkgPath = workspacePath(runId, "package.json");
  let npmScript = false;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath!, "utf8"));
    npmScript = typeof pkg?.scripts?.test === "string" && pkg.scripts.test.length > 0;
  } catch { /* no/invalid package.json */ }
  if (!npmScript) {
    return {
      ok: false,
      output: "",
      exitCode: 1,
      stderr: "No \"test\" script found in package.json. Run the project's test command with the terminal tool instead.",
    };
  }
  return remoteTerminal(containerId, "npm test 2>&1");
}

/** Copies the project into the container workspace.
 *  Returns "ok" | "missing" (no such source) | "failed" (transfer error). */
async function transferProject(containerId: string, sourcePath: string): Promise<"ok" | "missing" | "failed"> {
  if (!sourcePath || !fs.existsSync(sourcePath)) return "missing";
  // tar pipe: stream project into container's /workspace. --no-same-owner:
  // the container drops every capability, so restoring source ownership
  // (chown) would fail — and ownership is irrelevant inside the sandbox.
  const workspace = "/workspace";
  return new Promise((resolve) => {
    const tar = spawn("tar", ["cf", "-", "-C", sourcePath, "."], { windowsHide: true });
    const dock = spawn("docker", ["exec", "-i", containerId, "tar", "-xf", "-", "--no-same-owner", "-C", workspace], { windowsHide: true });
    let err = "";
    dock.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    tar.stdout.pipe(dock.stdin);
    dock.on("close", (code) => {
      console.log(`[worker] project transfer: code=${code} err=${err.slice(0, 100)}`);
      resolve(code === 0 ? "ok" : "failed");
    });
    tar.on("error", () => resolve("failed"));
    dock.on("error", () => resolve("failed"));
  });
}

// Tool RPC: the worker polls for tool requests from the control plane's
// ORION model and executes them against the mission container/workspace. The
// MODEL decides which tools to call; the worker is a dumb executor. The loop
// ends when the control-plane run finishes (observed via the `finished` flag
// — the worker NEVER decides completion itself) or the run is cancelled.
async function pollForToolRequests(runId: string, containerId: string): Promise<void> {
  while (activeContainers.has(runId) && !cancelledRuns.has(runId)) {
    try {
      const res = await cp("/api/v1/worker/tools/" + runId + "/next");
      if (res.finished) {
        console.log("[worker] control plane reports run finished: " + runId);
        return;
      }
      if (res.request) {
        const req = res.request;
        console.log("[worker] tool RPC: " + req.tool + " requestId=" + req.requestId);
        let result: { ok: boolean; output?: string; stderr?: string; exitCode?: number; error?: string };
        switch (req.tool) {
          case "read_file": {
            const r = await remoteReadFile(runId, String(req.arguments.path ?? ""));
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "write_file": {
            const r = await remoteWriteFile(runId, String(req.arguments.path ?? ""), String(req.arguments.content ?? ""));
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "edit_file": {
            const r = await remoteEditFile(
              runId,
              String(req.arguments.path ?? ""),
              String(req.arguments.old_string ?? ""),
              String(req.arguments.new_string ?? ""),
              req.arguments.replace_all === true
            );
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "list_directory": {
            const rel = req.arguments.path ? String(req.arguments.path) : "";
            const target = rel ? "/workspace/" + rel.replace(/^[/\\]+/, "") : "/workspace";
            const r = await remoteTerminal(containerId, "ls -la " + shq(target));
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "search_code": case "search_files": {
            const q = String(req.arguments.query ?? req.arguments.pattern ?? "");
            const cmd = "grep -rn --binary-files=without-match " + shq(q) +
              " /workspace --include=*.js --include=*.ts --include=*.jsx --include=*.tsx --include=*.json --include=*.py --include=*.go --include=*.rs --include=*.md 2>/dev/null | head -50";
            const r = await remoteTerminal(containerId, cmd);
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "terminal": case "run_command": {
            const cmd = String(req.arguments.command ?? "");
            await emitEvent(runId, "terminal.started", { command: cmd });
            const r = await remoteTerminal(containerId, cmd);
            await emitEvent(runId, "terminal.output", { data: (r.output || "").slice(0, 4000) });
            await emitEvent(runId, "terminal.completed", { exitOk: r.exitCode === 0, exitCode: r.exitCode });
            result = { ok: r.ok, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "run_tests": {
            await emitEvent(runId, "terminal.started", { command: "npm test" });
            const r = await remoteRunTests(runId, containerId);
            await emitEvent(runId, "terminal.output", { data: (r.output || r.stderr || "").slice(0, 4000) });
            await emitEvent(runId, "terminal.completed", { exitOk: r.exitCode === 0, exitCode: r.exitCode });
            result = { ok: r.exitCode === 0, output: r.output, stderr: r.stderr, exitCode: r.exitCode };
            break;
          }
          case "run_typecheck": {
            const r = await remoteTerminal(containerId, "npx --no-install tsc --noEmit 2>&1 || echo 'typescript not installed'");
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

async function executeJob(raw: JobAssignment): Promise<void> {
  const job = trustedJob(raw);
  const runId = job.runId;
  jobIdentity.set(runId, job);
  console.log(`[worker] executeJob START: ${runId} tenant=${job.tenantId} (role=${job.role ?? "executor"})`);
  // Distinct prefix from the SERVICE container (orvyn-worker-N): mission
  // containers must never match the worker's own name in any filter.
  const tenantTag = sanitizeSegment(job.tenantId || "unknown").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  const containerName = `orvyn-mission-${tenantTag}-${runId.slice(0, 8)}`;
  let containerId = "";
  const cancelTimer = startCancelPolling(runId);

  try {
    // The control-plane runtime owns run.started and run.completed — the
    // worker never claims either. It only reports its own lifecycle.
    await emitEvent(runId, "agent.phase", { phase: "UNDERSTAND", note: "Preparing remote mission container" });

    const workspace = workspaceFor(job);
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.mkdirSync(workspace, { recursive: true });

    const create = await docker([
      "create", "--name", containerName,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--memory", "1g", "--cpus", "1", "--pids-limit", "256",
      "--label", `orvyn.tenant_id=${job.tenantId}`,
      "--label", `orvyn.run_id=${runId}`,
      "--label", `orvyn.organization_id=${job.organizationId || ""}`,
      "-v", `${workspace}:/workspace`,
      "-w", "/workspace",
      SANDBOX_IMAGE,
      "sleep", String(CONTAINER_LIFETIME_S),
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

    // Transfer a checkout that actually exists on this machine. A Windows
    // path from the desktop, or a missing folder, is not a failure: the
    // mission workspace is the Cloud workspace and tool calls still run.
    const source = String(job.projectRoot ?? "");
    const foreign = /^[A-Za-z]:[\\/]/.test(source) || source.startsWith("\\\\");
    const workspaceRoot = path.resolve(WORKSPACE_DIR);
    const isParentWorkspace = Boolean(source) && path.resolve(source) === workspaceRoot;
    if (source && !foreign && !isParentWorkspace) {
      await emitEvent(runId, "agent.phase", { phase: "DISCOVER", note: "Transferring project to remote workspace" });
      const transferred = await transferProject(containerId, source);
      await emitEvent(runId, "tool.completed", {
        tool: "project_transfer",
        preview: transferred === "ok"
          ? `Project copied to remote workspace from ${source}`
          : transferred === "missing"
            ? `No project at ${source}. Using the Cloud workspace.`
            : `Project transfer from ${source} failed`,
        ok: transferred === "ok",
      });
      if (transferred === "failed") throw new Error(`Project transfer failed: ${source}`);
    } else {
      await emitEvent(runId, "agent.phase", {
        phase: "PREPARE",
        note: "No local checkout on this worker. Using the Cloud workspace.",
      });
    }

    // ENTER THE TOOL RPC LOOP — the control-plane ORION model drives all
    // tool calls from here. The worker executes generic requests only.
    await emitEvent(runId, "sandbox.ready", { container: containerName, projectRoot: job.projectRoot ?? "" });
    await emitEvent(runId, "agent.phase", { phase: "EXECUTE", note: "Mission container ready for tool requests" });
    console.log("[worker] entering tool RPC loop for " + runId);
    await pollForToolRequests(runId, containerId);
    console.log("[worker] tool RPC loop ended for " + runId);

    // Collect artifacts BEFORE cleanup — real files from the run.
    const artifacts = await collectArtifacts(runId);
    await emitEvent(runId, "artifacts.collected", { files: artifacts });
    await emitEvent(runId, "sandbox.stopped", { container: containerName, reason: "run finished" });
  } catch (err: any) {
    // Never a worker-side run.completed / run.error for the model's outcome:
    // the control plane owns the verdict. A worker infrastructure failure is
    // reported as a sandbox event; the control-plane tool call that was
    // waiting on the RPC fails truthfully on its own timeout.
    const wasCancelled = cancelledRuns.has(runId);
    await emitEvent(runId, "sandbox.stopped", {
      container: containerName,
      reason: wasCancelled ? "run cancelled" : `worker infrastructure failure: ${err.message}`,
    }).catch(() => {});
    console.error(`[worker] executeJob FAILED: ${runId}: ${err.message}`);
  } finally {
    stopCancelPolling(cancelTimer);
    if (containerId) {
      const rm = await docker(["rm", "-f", containerId]);
      console.log(`[worker] cleanup container ${containerId.slice(0, 12)}: code=${rm.code}`);
    }
    activeContainers.delete(runId);
    cancelledRuns.delete(runId);
    try { fs.rmSync(workspaceFor(job), { recursive: true, force: true }); } catch {}
    jobIdentity.delete(runId);
    console.log(`[worker] executeJob DONE: ${runId} tenant=${job.tenantId} (worker alive: yes)`);
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
      console.log(`[worker] job received: ${res.job.runId} tenant=${res.job.tenantId ?? "?"}`);
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

/**
 * A worker restart loses the in-memory container registry, which would leak
 * any mission containers from its previous life. They are all dead weight —
 * their runs can no longer be served — so remove them by name prefix.
 */
async function cleanupStaleMissionContainers(): Promise<void> {
  // orvyn-mission-* only — never the worker service container itself
  // (orvyn-worker-N), which a broader prefix would match and destroy.
  const res = await docker(["ps", "-a", "--filter", "name=orvyn-mission-", "--format", "{{.ID}} {{.Names}}"]);
  if (res.code !== 0) return;
  const lines = res.stdout.split("\n").filter(Boolean);
  for (const line of lines) {
    const [id, name] = line.split(/\s+/);
    const rm = await docker(["rm", "-f", id]);
    console.log(`[worker] boot cleanup: removed stale mission container ${name} (code=${rm.code})`);
  }
}

// ── Start ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`[worker] ORVYN Worker starting (Phase 4B hardened)`);
  console.log(`[worker]   ID: ${WORKER_ID}`);
  console.log(`[worker]   Control plane: ${CONTROL_PLANE}`);
  console.log(`[worker]   Workspace: ${WORKSPACE_DIR}`);
  console.log(`[worker]   Max concurrent: ${MAX_CONCURRENT}`);

  await detectDocker();
  await cleanupStaleMissionContainers();
  await register();

  setInterval(() => void heartbeat(), HEARTBEAT_INTERVAL);
  setInterval(() => void pollForJobs(), POLL_INTERVAL);

  console.log(`[worker] Running — heartbeat ${HEARTBEAT_INTERVAL / 1000}s, poll ${POLL_INTERVAL / 1000}s, cancel-check ${CANCEL_POLL_INTERVAL / 1000}s`);
}

void main();
