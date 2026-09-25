// Desktop Local Worker process. Registers with the control plane as this
// user's local_host executor and serves Tool RPC against the opened project.

import * as os from "os";
import { request } from "http";
import { request as httpsRequest } from "https";
import { executeLocalTool } from "./LocalToolExecutor";
import { detectLocalEnvironment } from "./environmentDetect";
import { processTracker } from "./processTracker";

const CONTROL_PLANE = process.env.ORVYN_CONTROL_PLANE || "http://127.0.0.1:4570";
const API_KEY = process.env.ORVYN_API_KEY || "";
const SECRET = process.env.ORVYN_LOCAL_WORKER_SECRET || "";
const WORKER_ID = `local_${os.hostname().split(".")[0]}_${process.pid}`;

async function cp(pathname: string, method = "GET", body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, CONTROL_PLANE.endsWith("/") ? CONTROL_PLANE : CONTROL_PLANE + "/");
    const payload = body ? JSON.stringify(body) : undefined;
    const lib = url.protocol === "https:" ? httpsRequest : request;
    const req = lib(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY } : {}),
        ...(SECRET ? { "x-orvyn-local-worker": SECRET } : {}),
        ...(payload ? { "Content-Length": Buffer.byteLength(payload).toString() } : {}),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        let body: any = {};
        try { body = data ? JSON.parse(data) : {}; } catch { body = {}; }
        // The HTTP status rides along so callers can tell "not registered"
        // (after a control-plane restart) from a normal empty answer.
        if (body && typeof body === "object") Object.defineProperty(body, "__status", { value: res.statusCode ?? 0, enumerable: false });
        resolve(body);
      });
    });
    req.setTimeout(12_000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

let registered = false;

async function register(): Promise<void> {
  const environment = await detectLocalEnvironment();
  const res = await cp("/api/v1/local-worker/register", "POST", {
    workerId: WORKER_ID,
    hostname: os.hostname(),
    projectRoot: process.env.ORVYN_PROJECT_ROOT || "",
    capabilities: ["local_host", "local_sandbox", "stdio-mcp"],
    environment,
    hostDesktopAllowed: process.env.ORVYN_HOST_DESKTOP === "1",
  });
  const status = res?.__status ?? 0;
  const ok = status >= 200 && status < 300 && res?.ok !== false;
  if (ok !== registered || !ok) {
    console.log(ok
      ? `[local-worker] registered with ${CONTROL_PLANE}`
      : `[local-worker] register refused (HTTP ${status}): ${String(res?.error ?? "").slice(0, 200)}`);
  }
  registered = ok;
}

/**
 * The control plane keeps workers in memory, so every deploy or restart
 * forgets this one. Heartbeat and poll answer 404/409 "not registered" then;
 * register again right away instead of staying invisible until the app
 * restarts (which is how runs ended with "Local Worker is offline").
 */
function needsRegister(res: any): boolean {
  const status = res?.__status ?? 0;
  return status === 401 || status === 404 || status === 409;
}

async function heartbeat(): Promise<void> {
  try {
    const res = await cp("/api/v1/local-worker/heartbeat", "POST", {
      workerId: WORKER_ID,
      projectRoot: process.env.ORVYN_PROJECT_ROOT || "",
      hostDesktopAllowed: process.env.ORVYN_HOST_DESKTOP === "1",
    });
    if (needsRegister(res)) { registered = false; await register(); }
  } catch {
    await register().catch(() => undefined);
  }
}

async function serveJob(job: { runId: string; projectRoot: string; role?: string; tenantId?: string }): Promise<void> {
  const projectRoot = job.projectRoot || process.env.ORVYN_PROJECT_ROOT || process.cwd();
  await cp(`/api/v1/local-worker/events/${job.runId}`, "POST", {
    type: "sandbox.ready",
    data: { projectRoot, role: job.role ?? "local_host", workerId: WORKER_ID },
  });
  while (true) {
    const next = await cp(`/api/v1/local-worker/tools/${job.runId}/next`);
    if (next.finished) {
      await processTracker.stopRun(job.runId);
      return;
    }
    if (!next.request) {
      await new Promise((r) => setTimeout(r, 250));
      continue;
    }
    const req = next.request;
    const started = Date.now();
    if (req.tool === "terminal" || req.tool === "run_command" || req.tool === "run_tests") {
      await cp(`/api/v1/local-worker/events/${job.runId}`, "POST", {
        type: "terminal.started",
        data: { command: req.arguments?.command ?? req.tool },
      });
    }
    const result = await executeLocalTool({
      tool: req.tool,
      arguments: req.arguments ?? {},
      runId: job.runId,
      tenantId: job.tenantId,
      projectRoot,
      onOutput: (chunk) => {
        void cp(`/api/v1/local-worker/events/${job.runId}`, "POST", {
          type: "terminal.output",
          data: { data: String(chunk).slice(0, 4000) },
        });
      },
    });
    if (req.tool === "terminal" || req.tool === "run_command" || req.tool === "run_tests") {
      await cp(`/api/v1/local-worker/events/${job.runId}`, "POST", {
        type: "terminal.completed",
        data: { exitOk: result.ok },
      });
    }
    await cp(`/api/v1/local-worker/tools/${job.runId}/result`, "POST", {
      requestId: req.requestId,
      runId: job.runId,
      ok: result.ok,
      output: result.output,
      error: result.error,
      durationMs: Date.now() - started,
    });
  }
}

async function poll(): Promise<void> {
  try {
    const res = await cp("/api/v1/local-worker/poll");
    if (needsRegister(res)) { registered = false; await register(); return; }
    if (res.job) {
      console.log(`[local-worker] job ${res.job.runId} in ${res.job.projectRoot || process.env.ORVYN_PROJECT_ROOT || "(no folder)"}`);
      void serveJob(res.job);
    }
  } catch {
    /* transient */
  }
}

async function main(): Promise<void> {
  await register().catch((err) => console.warn("[local-worker] register failed", err?.message));
  // These timers are what keeps the worker alive. With .unref() the process
  // exited right after "ready", the desktop app restarted it, and the
  // control plane saw it online only in short bursts after each restart.
  setInterval(() => { void heartbeat(); }, 10_000);
  setInterval(() => { void poll(); }, 1000);
  console.log(`[local-worker] ready ${WORKER_ID} → ${CONTROL_PLANE}`);
}

void main();
