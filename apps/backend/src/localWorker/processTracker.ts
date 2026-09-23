import { spawn, ChildProcess } from "child_process";
import { detectDevServerUrls } from "../desktop/previewDetect";

export type ProcessOwner = "this_run" | "other_run" | "user";
export type ServiceStatus = "starting" | "running" | "stopped" | "failed";
export type ProcessKind = "command" | "service";

export interface TrackedProcess {
  processId: string;
  runId?: string;
  projectId?: string;
  projectRoot: string;
  command: string;
  cwd: string;
  port?: number;
  startedAt: number;
  status: ServiceStatus;
  kind: ProcessKind;
  owner: ProcessOwner;
  pid?: number;
  logs: string;
}

const SERVICE_HINT = /\b(dev|start|serve|watch|preview)\b/i;
const MAX_LOG = 256 * 1024;

export class ProcessTracker {
  private procs = new Map<string, TrackedProcess & { child?: ChildProcess }>();
  private seq = 1;

  list(projectRoot?: string): TrackedProcess[] {
    const rows = [...this.procs.values()].map(publicView);
    return projectRoot ? rows.filter((p) => p.projectRoot === projectRoot) : rows;
  }

  findByPort(port: number): TrackedProcess | undefined {
    return this.list().find((p) => p.port === port && (p.status === "running" || p.status === "starting"));
  }

  findRunningService(projectRoot: string, command: string): TrackedProcess | undefined {
    return this.list(projectRoot).find(
      (p) => p.kind === "service" && p.command === command && (p.status === "running" || p.status === "starting")
    );
  }

  start(opts: {
    command: string;
    cwd: string;
    runId?: string;
    projectId?: string;
    projectRoot: string;
    owner?: ProcessOwner;
    kind?: ProcessKind;
    env?: NodeJS.ProcessEnv;
    onOutput?: (chunk: string, preview?: { url: string; port?: number; label: string }[]) => void;
  }): TrackedProcess {
    const kind = opts.kind ?? (SERVICE_HINT.test(opts.command) ? "service" : "command");
    if (kind === "service") {
      const existing = this.findRunningService(opts.projectRoot, opts.command);
      if (existing) return existing;
    }
    const processId = `proc_${this.seq++}`;
    const shell = process.platform === "win32" ? process.env.ComSpec || "powershell.exe" : process.env.SHELL || "bash";
    const args = process.platform === "win32"
      ? (shell.toLowerCase().includes("powershell") ? ["-NoLogo", "-Command", opts.command] : ["/c", opts.command])
      : ["-lc", opts.command];
    const child = spawn(shell, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
      detached: false,
    });
    const rec: TrackedProcess & { child?: ChildProcess } = {
      processId,
      runId: opts.runId,
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      command: opts.command,
      cwd: opts.cwd,
      startedAt: Date.now(),
      status: kind === "service" ? "starting" : "running",
      kind,
      owner: opts.owner ?? (opts.runId ? "this_run" : "user"),
      pid: child.pid,
      logs: "",
      child,
    };
    const append = (chunk: Buffer | string) => {
      const text = String(chunk);
      rec.logs = (rec.logs + text).slice(-MAX_LOG);
      const previews = detectDevServerUrls(rec.logs);
      if (previews[0]?.port) {
        rec.port = previews[0].port;
        rec.status = "running";
      }
      opts.onOutput?.(text, previews);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("exit", (code) => {
      rec.status = code === 0 ? "stopped" : "failed";
      rec.child = undefined;
    });
    child.on("error", () => {
      rec.status = "failed";
    });
    this.procs.set(processId, rec);
    return publicView(rec);
  }

  async stop(processId: string, opts: { runId?: string; force?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
    const rec = this.procs.get(processId);
    if (!rec) return { ok: false, error: `Unknown process ${processId}` };
    if (rec.owner === "user" && !opts.force) {
      return { ok: false, error: "Refusing to stop a user/manual process" };
    }
    if (opts.runId && rec.runId && rec.runId !== opts.runId && rec.owner !== "this_run") {
      return { ok: false, error: "Process belongs to another run" };
    }
    await killTree(rec.child, rec.pid);
    rec.status = "stopped";
    rec.child = undefined;
    return { ok: true };
  }

  async stopRun(runId: string): Promise<number> {
    let n = 0;
    for (const rec of this.procs.values()) {
      if (rec.runId === runId && rec.owner !== "user" && rec.status !== "stopped") {
        await killTree(rec.child, rec.pid);
        rec.status = "stopped";
        rec.child = undefined;
        n++;
      }
    }
    return n;
  }

  logs(processId: string): string {
    return this.procs.get(processId)?.logs ?? "";
  }
}

function publicView(rec: TrackedProcess): TrackedProcess {
  const { ...rest } = rec;
  delete (rest as { child?: unknown }).child;
  return rest;
}

async function killTree(child?: ChildProcess, pid?: number): Promise<void> {
  if (!child && !pid) return;
  try {
    if (process.platform === "win32" && pid) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      child?.kill("SIGTERM");
      if (pid) try { process.kill(-pid, "SIGTERM"); } catch { /* group may not exist */ }
    }
  } catch {
    /* already dead */
  }
}

export const processTracker = new ProcessTracker();
