// apps/backend/src/sandbox/DockerSandbox.ts
//
// Per-mission Docker sandbox for cloud execution (master spec §31).
//
// The problem it exists to solve: an agent mission asked to "run the tests"
// must not execute arbitrary project code on the API host. In sandbox mode,
// every command-class tool call executes inside a throwaway container that
// has: no network, no Linux capabilities, a memory/CPU/pid ceiling, a
// per-command timeout, and a whole-mission wall clock.
//
// File sync model (v1): the project is copied IN at mission start (minus
// node_modules/.git/.orvyn), and /workspace is copied back OUT at mission
// end. Host-side file tools, checkpoints, diffs and Undo keep operating on
// the host tree; the sandbox owns command execution. Mid-mission divergence
// between the two trees is possible and documented — the sync-out at the end
// is authoritative for files the commands created or modified.
//
// The interface (start/exec/mergeBack/stop) is deliberately Docker-free so a
// Kubernetes or VM backend can replace this class later without touching the
// agent runtime.

import { execFile, spawn } from "child_process";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import type { SandboxExecRequest, SandboxExecResult, SandboxProcess } from "../ai/tools/sandboxTools";
import { resolveSafeRealpath } from "../execution/pathSafety";
import { createHash } from "node:crypto";

const SANDBOX_IMAGE = process.env.ORVYN_SANDBOX_IMAGE || "node:22-slim";
/** Whole-mission wall clock, minutes. A wedged mission must not hold a box. */
const MISSION_TIMEOUT_MIN = Number(process.env.ORVYN_SANDBOX_TIMEOUT_MIN) || 30;
/** Per-command ceiling, seconds (enforced with coreutils `timeout` inside). */
const COMMAND_TIMEOUT_S = Number(process.env.ORVYN_SANDBOX_COMMAND_TIMEOUT_S) || 180;
/** Retained command output cap; live chunks still stream to the UI. */
const MAX_RETAINED_OUTPUT = Number(process.env.ORVYN_SANDBOX_MAX_OUTPUT_BYTES) || 2 * 1024 * 1024;

/** Directories never copied into (or back out of) the sandbox. */
const SYNC_EXCLUDE = new Set(["node_modules", ".git", ".orvyn", "dist", "release", ".cache", ".env", ".env.*", ".ssh", ".aws", ".npmrc", "*.pem", "*.key", "id_rsa", "id_ed25519"]);
function excludeSyncName(name: string): boolean {
  return SYNC_EXCLUDE.has(name) || /^\.env(?:\.|$)|\.(?:pem|key)$/i.test(name);
}
async function contentHash(file: string): Promise<string | undefined> {
  try { return createHash("sha256").update(await fs.readFile(file)).digest("hex"); }
  catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
}

function docker(args: string[], opts: { timeoutMs?: number; maxBuffer?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({ code: error ? ((error as any).code ?? 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      }
    );
  });
}

export interface ExecOptions {
  timeoutS?: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
  onOutputChunk?: (chunk: { stream: "stdout" | "stderr"; data: string }) => void;
}

export interface ExecResult {
  ok: boolean;
  output: string;
  exitCode: number;
  timedOut: boolean;
}

/** Host-side bookkeeping for a background process running in the container. */
interface ProcMeta {
  proc: SandboxProcess;
  logFile: string;
  statusFile: string;
  /** Inner command pid — the process group members die with this. */
  innerPidFile: string;
}

export class DockerSandbox {
  readonly containerId: string;
  private stopped = false;
  private initialFiles = new Map<string, string>();
  private wallClock?: NodeJS.Timeout;
  private processes = new Map<string, ProcMeta>();

  private constructor(containerId: string) {
    this.containerId = containerId;
  }

  /** True when the Docker daemon is reachable at all. */
  static async available(): Promise<boolean> {
    const res = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
    return res.code === 0 && res.stdout.trim().length > 0;
  }

  async copyRuntimeFile(source: string, destination: string): Promise<void> {
    const result = await docker(["cp", source, `${this.containerId}:${destination}`]);
    if (result.code !== 0) throw new Error("Could not copy the project tool runtime into its sandbox");
  }

  /**
   * Creates and starts a sandbox for a mission. `projectRoot` is copied in
   * (excluding heavy/irrelevant dirs); it is NOT mounted, so a runaway
   * container cannot reach the host filesystem at all.
   */
  static async start(missionId: string, projectRoot: string): Promise<DockerSandbox> {
    // Preflight: a missing daemon in sandbox mode must fail loudly, not fall
    // back to host execution — silent fallback would defeat the isolation.
    if (!(await DockerSandbox.available())) {
      throw new Error("Sandbox mode requires Docker, but the Docker daemon is not reachable. Install/start Docker or set ORVYN_MISSION_EXECUTION=host.");
    }

    const name = `orvyn-sandbox-${missionId.slice(0, 12)}-${Date.now().toString(36)}`;
    const create = await docker([
      "create",
      "--name", name,
      // Hard isolation: no network, no capabilities, no privilege escalation.
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      // Resource ceilings: a runaway build must not starve the host.
      "--memory", process.env.ORVYN_SANDBOX_MEMORY || "2g",
      "--cpus", process.env.ORVYN_SANDBOX_CPUS || "2",
      "--pids-limit", "512",
      SANDBOX_IMAGE,
      // Hard wall clock for the whole mission.
      "sleep", String(MISSION_TIMEOUT_MIN * 60),
    ]);
    if (create.code !== 0) {
      throw new Error(`Could not create sandbox container: ${create.stderr.trim() || create.stdout.trim()}`);
    }
    const containerId = create.stdout.trim();

    const sandbox = new DockerSandbox(containerId);
    const start = await docker(["start", containerId]);
    if (start.code !== 0) {
      await sandbox.stop();
      throw new Error(`Could not start sandbox container: ${start.stderr.trim()}`);
    }

    const mkdir = await sandbox.exec("mkdir -p /workspace", 15);
    if (!mkdir.ok) {
      await sandbox.stop();
      throw new Error(`Sandbox workspace could not be created: ${mkdir.output.slice(0, 200)}`);
    }
    await sandbox.copyIn(projectRoot);

    // Belt-and-braces wall clock: kill the container even if the runtime
    // forgets to stop it (crash between start and finally).
    sandbox.wallClock = setTimeout(() => void sandbox.stop(), MISSION_TIMEOUT_MIN * 60_000);
    sandbox.wallClock.unref?.();

    return sandbox;
  }

  /** Streams the host project tree into /workspace inside the container. */
  private async copyIn(projectRoot: string): Promise<void> {
    const snapshot = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (excludeSyncName(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await snapshot(file);
        else if (entry.isFile()) this.initialFiles.set(path.relative(projectRoot, file), (await contentHash(file))!);
      }
    };
    this.initialFiles.clear();
    await snapshot(projectRoot);
    await new Promise<void>((resolve, reject) => {
      const excludes = [...SYNC_EXCLUDE].flatMap((d) => ["--exclude", d]);
      const tar = spawn("tar", ["cf", "-", ...excludes, "-C", projectRoot, "."], { windowsHide: true });
      const dock = spawn("docker", ["exec", "-i", this.containerId, "tar", "--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", "/workspace"], { windowsHide: true });
      let err = "";
      dock.stderr.on("data", (d) => (err += d));
      tar.stderr.on("data", (d) => (err += d));
      tar.stdout.pipe(dock.stdin);
      dock.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`copyIn failed: ${err.slice(0, 300)}`))));
      tar.on("error", reject);
      dock.on("error", reject);
    });
  }

  /**
   * Runs a command inside the sandbox with a per-command timeout.
   * `workdir` is passed to `docker exec -w` (native cwd — no `cd` shell
   * wrapping); omitted for the legacy exec() path, whose callers compose
   * `cd` into the command themselves.
   */
  private spawnExec(command: string, opts: ExecOptions & { workdir?: string }): Promise<SandboxExecResult> {
    const timeoutS = opts.timeoutS ?? COMMAND_TIMEOUT_S;
    return new Promise((resolve) => {
      const commandId = `orvyn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const pidFile = `/tmp/${commandId}.pid`;
      // Record the in-container process-group leader (setsid), so Stop kills
      // the WHOLE tree — a bare kill of `timeout` would orphan its child.
      const wrapped = `echo $$ > ${pidFile}; exec setsid timeout --signal=KILL ${Math.max(1, Math.floor(timeoutS))} sh -c "$1"`;
      const child = spawn("docker", ["exec", ...(opts.workdir ? ["-w", opts.workdir] : []), this.containerId, "sh", "-c", wrapped, "orvyn-command", command], { windowsHide:true });
      let stdout = "", stderr = "", output = ""; let outputBytes = 0; let truncated = false; let settled = false;
      const timer = setTimeout(() => { if (!settled) child.kill("SIGKILL"); }, (timeoutS + 10) * 1000);
      const push = (stream: "stdout" | "stderr") => (d: any) => {
        const s = String(d);
        if (stream === "stdout") stdout += s; else stderr += s;
        opts.onOutputChunk?.({ stream, data: s });
        opts.onOutput?.(s);
        const bytes = Buffer.byteLength(s);
        if (outputBytes < MAX_RETAINED_OUTPUT) {
          const room = MAX_RETAINED_OUTPUT - outputBytes;
          const kept = Buffer.from(s).subarray(0, room).toString();
          output += kept; outputBytes += Buffer.byteLength(kept);
          if (bytes > room) truncated = true;
        } else truncated = true;
      };
      child.stdout.on("data", push("stdout")); child.stderr.on("data", push("stderr"));
      const abort = () => { void docker(["exec", this.containerId, "sh", "-c", `test -f ${pidFile} && { kill -KILL -- -$(cat ${pidFile}) 2>/dev/null; kill -KILL $(cat ${pidFile}) 2>/dev/null; } || true`], { timeoutMs: 5000 }); child.kill("SIGKILL"); };
      opts.signal?.addEventListener("abort", abort, { once:true });
      child.on("close", (code, sig) => {
        settled=true; clearTimeout(timer); opts.signal?.removeEventListener("abort", abort);
        const exitCode=code ?? (sig ? 137 : 1); const timedOut=exitCode===137 && !opts.signal?.aborted;
        const suffix=truncated ? `\n[output truncated after ${MAX_RETAINED_OUTPUT} bytes]` : "";
        resolve({ ok:exitCode===0, stdout, stderr, output:(output.trim()||"(no output)")+suffix, exitCode, timedOut });
      });
      child.on("error", (err) => { if(settled)return; settled=true; clearTimeout(timer); resolve({ok:false,stdout:"",stderr:String(err.message),output:String(err.message),exitCode:1,timedOut:false}); });
    });
  }

  /** Runs a command inside the sandbox with a per-command timeout (legacy combined-output surface). */
  async exec(command: string, timeoutOrOptions: number | ExecOptions = COMMAND_TIMEOUT_S): Promise<ExecResult> {
    if (this.stopped) return { ok:false, output:"Sandbox has already been stopped.", exitCode:-1, timedOut:false };
    const opts: ExecOptions = typeof timeoutOrOptions === "number" ? { timeoutS: timeoutOrOptions } : timeoutOrOptions;
    return this.spawnExec(command, opts);
  }

  /**
   * Structured execution: the provider resolves the workspace-relative cwd
   * natively (docker -w) and stdout/stderr come back as separate fields.
   */
  async execStructured(req: SandboxExecRequest): Promise<SandboxExecResult> {
    if (this.stopped) return { ok:false, stdout:"", stderr:"", output:"Sandbox has already been stopped.", exitCode:-1, timedOut:false };
    return this.spawnExec(req.command, { ...req, workdir: req.cwd ? `/workspace/${req.cwd}` : "/workspace" });
  }

  /** Re-syncs the host project tree into /workspace (incremental enough for a per-verification refresh). */
  async refresh(projectRoot: string): Promise<void> {
    if (this.stopped) return;
    await this.copyIn(projectRoot);
  }

  // ── Sandbox-native process lifecycle ────────────────────────────────────

  /**
   * Starts a background process inside the container. A supervising shell
   * writes the process pid, tees output to a log file and records the exit
   * code on completion — listProcesses/stopProcess/readLogs key off those.
   */
  async startProcess(req: { command: string; cwd?: string }): Promise<SandboxProcess> {
    const id = `proc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const workdir = req.cwd ? `/workspace/${req.cwd}` : "/workspace";
    const logFile = `/tmp/${id}.log`;
    const pidFile = `/tmp/${id}.pid`;
    const innerPidFile = `/tmp/${id}.innerpid`;
    const statusFile = `/tmp/${id}.status`;
    // The supervisor waits on the command it spawned, so it lives exactly as
    // long as the work, knows the inner pid (for stopProcess) and records the
    // exit status on completion. $1 carries the model's command through the
    // quoting layers untouched.
    const launcher = `nohup sh -c 'sh -c "$1" > ${logFile} 2>&1 & echo $! > ${innerPidFile}; wait $!; echo $? > ${statusFile}' orvyn-proc "$1" > /dev/null 2>&1 & echo $! > ${pidFile}; cat ${pidFile}`;
    const res = await docker(["exec", "-w", workdir, this.containerId, "sh", "-c", launcher, "orvyn-launcher", req.command], { timeoutMs: 15_000 });
    const pid = Number(res.stdout.trim());
    const proc: SandboxProcess = {
      id,
      command: req.command,
      cwd: req.cwd ?? "",
      pid: Number.isFinite(pid) ? pid : undefined,
      startedAt: Date.now(),
      status: res.code === 0 && Number.isFinite(pid) ? "running" : "failed",
      ...(res.code === 0 ? {} : { exitCode: res.code }),
    };
    this.processes.set(id, { proc, logFile, statusFile, innerPidFile });
    return proc;
  }

  async stopProcess(id: string): Promise<{ ok: boolean; error?: string }> {
    const meta = this.processes.get(id);
    if (!meta) return { ok: false, error: `Unknown sandbox process "${id}"` };
    if (meta.proc.status !== "running") return { ok: true };
    // Kill the inner command, then the supervisor waiting on it. Grandchild
    // processes of the command are not individually tracked — the mission
    // container teardown is their hard boundary.
    await docker(
      ["exec", this.containerId, "sh", "-c",
        `test -f ${meta.innerPidFile} && kill -KILL $(cat ${meta.innerPidFile}) 2>/dev/null; ` +
        `test -f ${meta.statusFile} || kill -KILL ${meta.proc.pid ?? -1} 2>/dev/null; ` +
        `echo stopped > ${meta.statusFile}; true`],
      { timeoutMs: 10_000 }
    );
    meta.proc.status = "stopped";
    return { ok: true };
  }

  async processLogs(id: string, tail = 80): Promise<{ stdout: string; stderr: string }> {
    const meta = this.processes.get(id);
    if (!meta) throw new Error(`Unknown sandbox process "${id}"`);
    const res = await docker(["exec", this.containerId, "sh", "-c", `test -f ${meta.logFile} && tail -n ${Math.max(1, tail)} ${meta.logFile} || true`], { timeoutMs: 10_000 });
    return { stdout: res.stdout, stderr: "" };
  }

  async listProcesses(): Promise<SandboxProcess[]> {
    const out: SandboxProcess[] = [];
    for (const meta of this.processes.values()) {
      if (meta.proc.status === "running") {
        // A status file means the supervisor saw the process exit — read the
        // recorded code; otherwise probe liveness with kill -0.
        const probe = await docker(
          ["exec", this.containerId, "sh", "-c", `if test -f ${meta.statusFile}; then cat ${meta.statusFile}; elif kill -0 ${meta.proc.pid ?? -1} 2>/dev/null; then echo RUNNING; else echo DEAD; fi`],
          { timeoutMs: 10_000 }
        );
        const seen = probe.stdout.trim();
        if (seen === "RUNNING") meta.proc.status = "running";
        else if (seen === "DEAD") { meta.proc.status = "failed"; }
        else { meta.proc.status = "exited"; meta.proc.exitCode = Number(seen); }
      }
      out.push({ ...meta.proc });
    }
    return out;
  }

  /** Copies /workspace out of the container into a host temp dir. */
  private async syncOut(): Promise<string | null> {
    if (this.stopped) return null;
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "orvyn-sandbox-out-"));
    const res = await docker(["cp", `${this.containerId}:/workspace/.`, outDir], { timeoutMs: 120_000 });
    if (res.code !== 0) {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    return outDir;
  }

  /** Merges the sandbox's final tree over the host project. */
  async mergeBack(projectRoot: string): Promise<{ mergedFiles: number }> {
    const outDir = await this.syncOut();
    if (!outDir) return { mergedFiles: 0 };
    let merged = 0;
    const changes: Array<{ from: string; to: string; prior: string | undefined }> = [];
    const walk = async (src: string, dest: string) => {
      const entries = await fs.readdir(src, { withFileTypes: true });
      for (const e of entries) {
        if (excludeSyncName(e.name)) continue;
        const from = path.join(src, e.name);
        const to = await resolveSafeRealpath(projectRoot, path.relative(projectRoot, path.join(dest, e.name)));
        if (e.isDirectory()) {
          await walk(from, to);
        } else if (e.isFile()) {
          const relative = path.relative(projectRoot, to);
          const initial = this.initialFiles.get(relative);
          const result = await contentHash(from);
          const current = await contentHash(to);
          if (result === initial || result === current) continue;
          if (current !== initial) throw new Error(`Project file ${relative} changed outside the sandbox; merge refused. Existing edits were preserved.`);
          changes.push({ from, to, prior: current });
        }
      }
    };
    try {
      await walk(outDir, projectRoot);
      for (const change of changes) {
        if (await contentHash(change.to) !== change.prior) throw new Error("Project changed during sandbox merge; existing edits were preserved.");
        await fs.mkdir(path.dirname(change.to), { recursive: true });
        await fs.copyFile(change.from, change.to);
        merged++;
      }
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
    return { mergedFiles: merged };
  }

  /** Removes the container — and with it every sandbox process. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.processes.clear();
    if (this.wallClock) clearTimeout(this.wallClock);
    await docker(["rm", "-f", this.containerId], { timeoutMs: 30_000 });
  }
}
