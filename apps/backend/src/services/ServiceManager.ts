// apps/backend/src/services/ServiceManager.ts
//
// The one owner of long-running processes (dev servers, watchers, APIs).
// A service belongs to a project, not to a run: finishing, failing or
// cancelling a run never stops it. It stops only when the user or ORION
// stops it explicitly, or when the process hosting the manager shuts down.
//
// Used by the in-process tools (Local on the same host, and ORVYN Cloud
// workspaces on the control plane) and by the desktop Local Worker.

import { spawn, type ChildProcess } from "child_process";
import * as net from "net";
import { detectDevServerUrls } from "../desktop/previewDetect";

export type ServiceStatus = "starting" | "running" | "unhealthy" | "stopped" | "failed";

export interface ServiceRecord {
  serviceId: string;
  /** Short name for people: "vite", "next", "npm run dev". */
  name: string;
  command: string;
  cwd: string;
  projectRoot: string;
  runId?: string;
  tenantId?: string;
  pid?: number;
  port?: number;
  url?: string;
  status: ServiceStatus;
  startedAt: number;
  readyAt?: number;
  lastHealthAt?: number;
  exitCode?: number | null;
  /** Why it stopped: "stopped by ORION", "stopped by the user", "exited". */
  stopReason?: string;
}

export interface StartServiceInput {
  command: string;
  cwd: string;
  projectRoot?: string;
  runId?: string;
  tenantId?: string;
  env?: NodeJS.ProcessEnv;
  /** Legacy hint; the real port comes from the service's own output. */
  port?: number;
}

export interface StartOutcome {
  record: ServiceRecord;
  /** An identical service was already running; nothing new was started. */
  reused: boolean;
  /** Listening (URL answered) or, with no URL, still alive after the wait. */
  ready: boolean;
}

const MAX_LOG_BYTES = 256 * 1024;
const HEALTH_INTERVAL_MS = 15_000;
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g;

// ── Which commands are services ──────────────────────────────────────────

const SCRIPT = String.raw`(?:dev|start|serve|server|preview|watch)(?::[\w.-]+)?`;
const SERVICE_SEGMENTS: RegExp[] = [
  new RegExp(String.raw`^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?${SCRIPT}(?:\s|$)`, "i"),
  new RegExp(String.raw`^deno\s+task\s+${SCRIPT}(?:\s|$)`, "i"),
  /^(?:npx\s+(?:-y\s+)?|bunx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+)?vite(?:\s+(?:dev|serve|preview))?(?:\s+-{1,2}[\w-]+(?:[= ]\S+)?)*\s*$/i,
  /^(?:npx\s+(?:-y\s+)?)?(?:next|nuxt|nuxi|astro|remix|svelte-kit)\s+(?:dev|start|preview)\b/i,
  /^(?:npx\s+(?:-y\s+)?)?(?:ng\s+serve|webpack\s+serve|webpack-dev-server|react-scripts\s+start|vue-cli-service\s+serve|parcel(?!\s+build)\b)/i,
  /^(?:npx\s+(?:-y\s+)?)?(?:nodemon|serve|http-server|live-server|json-server|tsx\s+watch)\b/i,
  /^node\s+(?:--watch\s+)?\S*(?:server|app)\.(?:c|m)?[jt]s\b/i,
  /^python3?\s+(?:-m\s+http\.server|\S*manage\.py\s+runserver|\S*app\.py)\b/i,
  /^(?:flask\s+run|uvicorn|gunicorn|hypercorn)\b/i,
  /^php\s+(?:-S\s|artisan\s+serve)/i,
  /^(?:bundle\s+exec\s+)?rails\s+(?:s|server)\b/i,
  /^(?:go\s+run|cargo\s+(?:run|watch))\b.*\b(?:server|serve)\b/i,
];

/** The last shell step, without env assignments, nohup, or a trailing "&". */
function lastSegment(command: string): string {
  const parts = String(command ?? "").split(/&&|\|\||;/);
  let seg = (parts[parts.length - 1] ?? "").trim().replace(/\s*&\s*$/, "").trim();
  seg = seg.replace(/^nohup\s+/i, "");
  const assignment = /^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/;
  while (assignment.test(seg)) seg = seg.replace(assignment, "");
  return seg.replace(/\s*\d?>.*$/, "").trim();
}

export function isServiceCommand(command: string): boolean {
  const seg = lastSegment(command);
  if (!seg) return false;
  return SERVICE_SEGMENTS.some((re) => re.test(seg));
}

/** "npm run dev &" and "nohup vite &" run in the foreground, owned by the manager. */
export function serviceCommandLine(command: string): string {
  return String(command ?? "").trim().replace(/^nohup\s+/i, "").replace(/\s*&\s*$/, "").trim();
}

function serviceName(command: string): string {
  const seg = lastSegment(command);
  const m = /\b(vite|next|nuxt|astro|remix|webpack|parcel|nodemon|uvicorn|flask|gunicorn|rails|http\.server|http-server|live-server|json-server)\b/i.exec(seg);
  if (m) return m[1]!.toLowerCase() === "http.server" ? "python http.server" : m[1]!.toLowerCase();
  return seg.length > 40 ? seg.slice(0, 40) + "…" : seg;
}

function sameCommand(a: string, b: string): boolean {
  const norm = (s: string) => serviceCommandLine(s).replace(/\s+/g, " ").toLowerCase();
  return norm(a) === norm(b);
}

// ── TCP check ─────────────────────────────────────────────────────────────

function tcpOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Dev servers bind 127.0.0.1, ::1 or 0.0.0.0 depending on the tool and OS. */
export async function portAnswers(port: number): Promise<boolean> {
  if (await tcpOpen("127.0.0.1", port)) return true;
  return tcpOpen("::1", port);
}

// ── Manager ───────────────────────────────────────────────────────────────

interface Live {
  record: ServiceRecord;
  child?: ChildProcess;
  logs: string;
  listeners: Set<(chunk: string) => void>;
  exited: Promise<void>;
  misses: number;
}

function isActive(status: ServiceStatus): boolean {
  return status === "starting" || status === "running" || status === "unhealthy";
}

export class ServiceManager {
  private services = new Map<string, Live>();
  private seq = 1;
  private healthTimer?: NodeJS.Timeout;

  /** The Local Worker's ids differ from the host's, so the app can tell them apart. */
  constructor(private readonly idPrefix = process.env.ORVYN_LOCAL_WORKER === "1" ? "local_svc_" : "svc_") {}

  list(filter?: string | { runId?: string; projectRoot?: string; active?: boolean }): ServiceRecord[] {
    const f = typeof filter === "string" ? { runId: filter } : filter ?? {};
    return [...this.services.values()]
      .map((s) => ({ ...s.record }))
      .filter((r) => (!f.runId || r.runId === f.runId) && (!f.projectRoot || r.projectRoot === f.projectRoot))
      .filter((r) => !f.active || isActive(r.status));
  }

  get(serviceId: string): ServiceRecord | undefined {
    const s = this.services.get(serviceId);
    return s ? { ...s.record } : undefined;
  }

  logs(serviceId: string, tailLines = 80): string {
    const s = this.services.get(serviceId);
    if (!s) return "";
    return s.logs.split(/\r?\n/).slice(-Math.max(1, tailLines)).join("\n");
  }

  /** Streams output to one viewer (a tool call) until the returned function is called. */
  subscribe(serviceId: string, fn: (chunk: string) => void): () => void {
    const s = this.services.get(serviceId);
    if (!s) return () => {};
    s.listeners.add(fn);
    return () => { s.listeners.delete(fn); };
  }

  findRunning(projectRoot: string, command: string): ServiceRecord | undefined {
    return this.list({ projectRoot, active: true }).find((r) => sameCommand(r.command, command));
  }

  start(input: StartServiceInput): ServiceRecord {
    return this.launch(input).record;
  }

  /** Starts (or reuses) a service and waits until it listens, exits, or the wait ends. */
  async startAndWait(
    input: StartServiceInput & { readyTimeoutMs?: number; onOutput?: (chunk: string) => void }
  ): Promise<StartOutcome> {
    const { record, reused } = this.launch(input);
    if (reused) return { record, reused, ready: record.status === "running" };
    const off = input.onOutput ? this.subscribe(record.serviceId, input.onOutput) : () => {};
    try {
      const ready = await this.waitUntilReady(record.serviceId, input.readyTimeoutMs ?? 60_000);
      return { record: this.get(record.serviceId)!, reused: false, ready };
    } finally {
      off();
    }
  }

  private launch(input: StartServiceInput): { record: ServiceRecord; reused: boolean } {
    const projectRoot = input.projectRoot ?? input.cwd;
    const command = serviceCommandLine(input.command);
    const existing = this.findRunning(projectRoot, command);
    if (existing) return { record: existing, reused: true };

    const serviceId = `${this.idPrefix}${this.seq++}`;
    const record: ServiceRecord = {
      serviceId,
      name: serviceName(command),
      command,
      cwd: input.cwd,
      projectRoot,
      runId: input.runId,
      tenantId: input.tenantId,
      port: input.port,
      status: "starting",
      startedAt: Date.now(),
    };
    const child = spawn(command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
      // Own process group on POSIX so stop() takes the whole tree down, and
      // a signal to the host's group does not take the service with it.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", BROWSER: "none", ...input.env },
    });
    record.pid = child.pid;
    let resolveExit!: () => void;
    const live: Live = {
      record,
      child,
      logs: "",
      listeners: new Set(),
      exited: new Promise<void>((r) => (resolveExit = r)),
      misses: 0,
    };
    const append = (buf: Buffer) => {
      const text = buf.toString("utf8").replace(ANSI, "");
      live.logs = (live.logs + text).slice(-MAX_LOG_BYTES);
      if (!record.url) {
        const found = detectDevServerUrls(live.logs).find((p) => p.port);
        if (found) { record.url = found.url; record.port = found.port; }
      }
      for (const fn of live.listeners) { try { fn(text); } catch { /* a viewer never breaks the service */ } }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
      live.logs += `\n[service error] ${err.message}\n`;
      record.status = "failed";
      record.stopReason = err.message;
      live.child = undefined;
      resolveExit();
    });
    child.on("exit", (code, signal) => {
      live.child = undefined;
      record.exitCode = code;
      if (record.status !== "stopped") {
        record.status = code === 0 ? "stopped" : "failed";
        record.stopReason = code === 0 ? "exited" : `exited (${code ?? signal ?? "killed"})`;
      }
      resolveExit();
    });
    this.services.set(serviceId, live);
    this.ensureHealthLoop();
    return { record: { ...record }, reused: false };
  }

  async waitUntilReady(serviceId: string, timeoutMs: number): Promise<boolean> {
    const live = this.services.get(serviceId);
    if (!live) return false;
    const deadline = Date.now() + timeoutMs;
    let exited = false;
    void live.exited.then(() => { exited = true; });
    while (Date.now() < deadline) {
      if (exited || !isActive(live.record.status)) return false;
      if (live.record.port && (await portAnswers(live.record.port))) {
        live.record.status = "running";
        live.record.readyAt = live.record.lastHealthAt = Date.now();
        return true;
      }
      await Promise.race([new Promise((r) => setTimeout(r, 400)), live.exited]);
    }
    if (exited || !live.child) return false;
    // Alive with no URL printed (a watcher, a quiet API): running, not proven reachable.
    if (!live.record.port) {
      live.record.status = "running";
      return true;
    }
    return false;
  }

  /** Run completion must not tear these down; this only reports them. */
  releaseRun(runId: string): ServiceRecord[] {
    return this.list({ runId });
  }

  stop(serviceId: string, reason = "stopped"): ServiceRecord | undefined {
    const live = this.services.get(serviceId);
    if (!live) return undefined;
    live.record.status = "stopped";
    live.record.stopReason = reason;
    killTree(live.child);
    live.child = undefined;
    return { ...live.record };
  }

  stopAll(reason = "host shutting down"): number {
    let n = 0;
    for (const live of this.services.values()) {
      if (live.child) { this.stop(live.record.serviceId, reason); n++; }
    }
    return n;
  }

  private ensureHealthLoop(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => void this.checkHealth(), HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  async checkHealth(): Promise<void> {
    for (const live of this.services.values()) {
      const r = live.record;
      if (!live.child || !r.port || !isActive(r.status)) continue;
      const ok = await portAnswers(r.port);
      r.lastHealthAt = Date.now();
      if (ok) { live.misses = 0; r.status = "running"; r.readyAt ??= r.lastHealthAt; }
      else if (r.status !== "starting" && ++live.misses >= 2) r.status = "unhealthy";
    }
  }
}

function killTree(child?: ChildProcess): void {
  if (!child?.pid) return;
  const pid = child.pid;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      return;
    }
    try { process.kill(-pid, "SIGTERM"); } catch { child.kill("SIGTERM"); }
    const hard = setTimeout(() => {
      try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
    }, 3000);
    hard.unref?.();
  } catch {
    /* already gone */
  }
}

/** Plain-language result for the model and the chat row. */
export function describeService(outcome: StartOutcome, logsTail = ""): { ok: boolean; output: string; error?: string } {
  const r = outcome.record;
  const stopHint = `It keeps running after this run finishes. Stop it with stop_process ${r.serviceId}.`;
  if (outcome.reused) {
    return { ok: true, output: `Already running as ${r.serviceId}: ${r.command}${r.url ? `\nURL: ${r.url}` : ""}\n${stopHint}` };
  }
  if (r.status === "failed" || r.status === "stopped") {
    const error = `The service "${r.command}" ${r.stopReason ?? "exited"} before it was ready (${r.serviceId}).${logsTail ? `\nLast output:\n${logsTail}` : ""}`;
    return { ok: false, output: logsTail, error };
  }
  if (outcome.ready && r.url) {
    return { ok: true, output: `Service ${r.serviceId} is running: ${r.command}\nURL: ${r.url}\n${stopHint}` };
  }
  if (r.port && !outcome.ready) {
    return {
      ok: true,
      output: `Service ${r.serviceId} started (${r.command}) and printed ${r.url}, but that port is not answering yet. Check read_process_logs ${r.serviceId}.\n${stopHint}`,
    };
  }
  return { ok: true, output: `Service ${r.serviceId} is running: ${r.command}\nNo URL printed yet. Check read_process_logs ${r.serviceId}.\n${stopHint}` };
}

/** One call for every tool path: start (or reuse) and describe. */
export async function runService(input: StartServiceInput & { onOutput?: (chunk: string) => void; readyTimeoutMs?: number }, manager = serviceManager) {
  const outcome = await manager.startAndWait(input);
  const tail = outcome.record.status === "failed" || outcome.record.status === "stopped" ? manager.logs(outcome.record.serviceId, 30) : "";
  return { outcome, result: describeService(outcome, tail) };
}

export const serviceManager = new ServiceManager();
