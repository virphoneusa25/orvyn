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

const SANDBOX_IMAGE = process.env.ORVYN_SANDBOX_IMAGE || "node:22-slim";
/** Whole-mission wall clock, minutes. A wedged mission must not hold a box. */
const MISSION_TIMEOUT_MIN = Number(process.env.ORVYN_SANDBOX_TIMEOUT_MIN) || 30;
/** Per-command ceiling, seconds (enforced with coreutils `timeout` inside). */
const COMMAND_TIMEOUT_S = Number(process.env.ORVYN_SANDBOX_COMMAND_TIMEOUT_S) || 180;

/** Directories never copied into (or back out of) the sandbox. */
const SYNC_EXCLUDE = new Set(["node_modules", ".git", ".orvyn", "dist", "release", ".cache"]);

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

export interface ExecResult {
  ok: boolean;
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export class DockerSandbox {
  readonly containerId: string;
  private stopped = false;
  private wallClock?: NodeJS.Timeout;

  private constructor(containerId: string) {
    this.containerId = containerId;
  }

  /** True when the Docker daemon is reachable at all. */
  static async available(): Promise<boolean> {
    const res = await docker(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 8000 });
    return res.code === 0 && res.stdout.trim().length > 0;
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
    await new Promise<void>((resolve, reject) => {
      const excludes = [...SYNC_EXCLUDE].flatMap((d) => ["--exclude", d]);
      const tar = spawn("tar", ["cf", "-", ...excludes, "-C", projectRoot, "."], { windowsHide: true });
      const dock = spawn("docker", ["exec", "-i", this.containerId, "tar", "xf", "-", "-C", "/workspace"], { windowsHide: true });
      let err = "";
      dock.stderr.on("data", (d) => (err += d));
      tar.stderr.on("data", (d) => (err += d));
      tar.stdout.pipe(dock.stdin);
      dock.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`copyIn failed: ${err.slice(0, 300)}`))));
      tar.on("error", reject);
      dock.on("error", reject);
    });
  }

  /** Runs a command inside the sandbox with a per-command timeout. */
  async exec(command: string, timeoutS = COMMAND_TIMEOUT_S): Promise<ExecResult> {
    if (this.stopped) {
      return { ok: false, output: "Sandbox has already been stopped.", exitCode: -1, timedOut: false };
    }
    const res = await docker(
      ["exec", this.containerId, "timeout", "--signal=KILL", String(timeoutS), "sh", "-c", command],
      { timeoutMs: (timeoutS + 15) * 1000 }
    );
    const timedOut = res.code === 137;
    const output = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return { ok: res.code === 0, output: output || "(no output)", exitCode: res.code, timedOut };
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
    const walk = async (src: string, dest: string) => {
      const entries = await fs.readdir(src, { withFileTypes: true });
      for (const e of entries) {
        if (SYNC_EXCLUDE.has(e.name)) continue;
        const from = path.join(src, e.name);
        const to = path.join(dest, e.name);
        if (e.isDirectory()) {
          await fs.mkdir(to, { recursive: true });
          await walk(from, to);
        } else if (e.isFile()) {
          await fs.mkdir(path.dirname(to), { recursive: true });
          await fs.copyFile(from, to);
          merged++;
        }
      }
    };
    try {
      await walk(outDir, projectRoot);
    } finally {
      await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
    }
    return { mergedFiles: merged };
  }

  /** Removes the container. Safe to call more than once. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.wallClock) clearTimeout(this.wallClock);
    await docker(["rm", "-f", this.containerId], { timeoutMs: 30_000 });
  }
}
