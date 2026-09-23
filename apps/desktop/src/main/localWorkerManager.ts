// Electron-owned Local Worker: one child process per ORVYN install.
// Talks to the control plane with the user's session (never 0.0.0.0).
// Crash recovery uses bounded backoff. Multiple windows share one lock.

import { app } from "electron";
import { spawn, ChildProcess } from "child_process";
import { createWriteStream, openSync, writeFileSync, unlinkSync } from "fs";
import { promises as fs } from "fs";
import * as path from "path";
import { randomBytes } from "crypto";

export type LocalEngineHealth = "ready" | "degraded" | "offline";

export interface LocalWorkerStatus {
  state: LocalEngineHealth;
  workerId?: string;
  detail?: string;
  restarts: number;
  hostDesktopAllowed: boolean;
}

const LOCK_NAME = "orvyn-local-worker.lock";

export class LocalWorkerManager {
  private child: ChildProcess | null = null;
  private secret = randomBytes(24).toString("hex");
  private restarts = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private quitting = false;
  private lockFd: number | null = null;
  private status: LocalWorkerStatus = { state: "offline", restarts: 0, hostDesktopAllowed: false };
  private projectRoot: string | null = null;
  private backendUrl = "http://127.0.0.1:4570";
  private apiKey = "";

  configure(opts: { backendUrl?: string; apiKey?: string; projectRoot?: string | null; hostDesktopAllowed?: boolean }): void {
    if (opts.backendUrl) this.backendUrl = opts.backendUrl;
    if (opts.apiKey !== undefined) this.apiKey = opts.apiKey;
    if (opts.projectRoot !== undefined) this.projectRoot = opts.projectRoot;
    if (opts.hostDesktopAllowed !== undefined) this.status.hostDesktopAllowed = opts.hostDesktopAllowed;
  }

  getStatus(): LocalWorkerStatus {
    return { ...this.status };
  }

  async start(): Promise<void> {
    if (this.quitting || this.child) return;
    if (!this.acquireLock()) {
      this.status = { ...this.status, state: "ready", detail: "Local worker already owned by another ORVYN window" };
      return;
    }
    const entry = await this.resolveEntry();
    if (!entry) {
      this.status = { state: "degraded", restarts: this.restarts, hostDesktopAllowed: this.status.hostDesktopAllowed, detail: "Local worker entry not packaged" };
      return;
    }
    const log = createWriteStream(path.join(app.getPath("userData"), "local-worker.log"), { flags: "a" });
    const executable = entry.node;
    this.child = spawn(executable, [entry.script], {
      cwd: entry.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ORVYN_CONTROL_PLANE: this.backendUrl,
        ORVYN_API_KEY: this.apiKey,
        ORVYN_LOCAL_WORKER_SECRET: this.secret,
        ORVYN_PROJECT_ROOT: this.projectRoot ?? "",
        ORVYN_HOST_DESKTOP: this.status.hostDesktopAllowed ? "1" : "0",
        ORVYN_LOCAL_WORKER: "1",
      },
    });
    this.child.stdout?.pipe(log, { end: false });
    this.child.stderr?.pipe(log, { end: false });
    this.status = { state: "ready", workerId: `local_${process.pid}`, restarts: this.restarts, hostDesktopAllowed: this.status.hostDesktopAllowed };
    this.child.once("exit", () => {
      this.child = null;
      this.status.state = "offline";
      log.end();
      if (!this.quitting) this.scheduleRestart();
    });
    this.child.once("error", () => {
      this.child = null;
      this.status = { state: "degraded", restarts: this.restarts, hostDesktopAllowed: this.status.hostDesktopAllowed, detail: "Local worker failed to spawn" };
    });
  }

  stop(): void {
    this.quitting = true;
    if (this.timer) clearTimeout(this.timer);
    this.child?.kill();
    this.child = null;
    this.releaseLock();
    this.status.state = "offline";
  }

  private scheduleRestart(): void {
    if (this.restarts >= 8) {
      this.status = { state: "degraded", restarts: this.restarts, hostDesktopAllowed: this.status.hostDesktopAllowed, detail: "Local worker crashed repeatedly" };
      return;
    }
    const delay = Math.min(30_000, 750 * 2 ** this.restarts);
    this.restarts += 1;
    this.timer = setTimeout(() => {
      void this.start();
    }, delay);
  }

  private acquireLock(): boolean {
    const lockPath = path.join(app.getPath("userData"), LOCK_NAME);
    try {
      this.lockFd = openSync(lockPath, "wx");
      writeFileSync(this.lockFd, String(process.pid));
      return true;
    } catch {
      return false;
    }
  }

  private releaseLock(): void {
    try {
      if (this.lockFd != null) {
        unlinkSync(path.join(app.getPath("userData"), LOCK_NAME));
      }
    } catch {
      /* already released */
    }
    this.lockFd = null;
  }

  private async resolveEntry(): Promise<{ node: string; script: string; cwd: string } | null> {
    const packagedBackend = path.join(process.resourcesPath, "backend");
    const devBackend = path.resolve(__dirname, "../../../backend");
    const backend = app.isPackaged ? packagedBackend : devBackend;
    const candidates = [
      path.join(backend, "dist/localWorker/entry.js"),
      path.join(backend, "dist/localWorker/entry.ts"),
    ];
    for (const script of candidates) {
      try {
        await fs.access(script);
        return {
          node: app.isPackaged ? path.join(backend, "node.exe") : "node",
          script,
          cwd: backend,
        };
      } catch {
        /* try next */
      }
    }
    return null;
  }
}

export const localWorkerManager = new LocalWorkerManager();
