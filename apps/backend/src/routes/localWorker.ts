// User-scoped local worker: the desktop process registers as this tenant's
// local_host executor. ToolGateway on the control plane still authorizes
// every call; this only serves Tool RPC against the opened project root.

import { Router } from "express";
import { toolRpc } from "../execution/ToolRpc";
import { executeLocalTool } from "../localWorker/LocalToolExecutor";
import { detectLocalEnvironment } from "../localWorker/environmentDetect";
import { processTracker } from "../localWorker/processTracker";
import type { AgentEventType } from "../agent/events";
import type { RunStore } from "../agent/events";
import type { Tenant } from "../tenancy/TenantManager";

export type LocalWorkerHealth = "ready" | "degraded" | "offline";

interface LocalWorkerRecord {
  workerId: string;
  tenantId: string;
  hostname: string;
  projectRoot?: string;
  capabilities: string[];
  environment?: Record<string, string | undefined>;
  lastHeartbeat: number;
  status: LocalWorkerHealth;
  hostDesktopAllowed: boolean;
}

const workers = new Map<string, LocalWorkerRecord>();

interface LocalJob {
  runId: string;
  tenantId: string;
  projectRoot: string;
  role: "local_host" | "local_sandbox";
  createdAt: number;
  assignedTo?: string;
}

const jobs: LocalJob[] = [];

export function hasOnlineLocalWorker(tenantId: string): boolean {
  const w = workers.get(tenantId);
  return !!w && w.status !== "offline" && Date.now() - w.lastHeartbeat < 45_000;
}

export function localWorkerHealth(tenantId: string): { state: LocalWorkerHealth; detail?: string; environment?: Record<string, string | undefined> } {
  const w = workers.get(tenantId);
  if (!w || Date.now() - w.lastHeartbeat >= 45_000) return { state: "offline", detail: "Local worker is not connected" };
  return { state: w.status, environment: w.environment };
}

const COMMAND_TOOLS = new Set(["terminal", "run_command", "run_tests", "run_build", "run_typecheck", "run_linter"]);

/** The call id of the command tool that has started and not finished yet. */
export function runningCommandCallId(events: Array<{ type: string; data?: Record<string, unknown> }>): string | undefined {
  const finished = new Set<string>();
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const callId = String(e.data?.callId ?? "");
    if (!callId) continue;
    if (e.type === "tool.completed" || e.type === "tool.failed") finished.add(callId);
    if (e.type === "tool.started" && COMMAND_TOOLS.has(String(e.data?.tool ?? "")) && !finished.has(callId)) return callId;
  }
  return undefined;
}

export function queueLocalHostJob(runId: string, projectRoot: string, tenantId: string, role: "local_host" | "local_sandbox" = "local_host"): void {
  jobs.push({ runId, tenantId, projectRoot, role, createdAt: Date.now() });
}

export function localWorkerRouter(
  requireTenant: (req: any) => Tenant,
  getRunStore: (tenantId: string) => RunStore
): Router {
  const r = Router();

  r.post("/register", async (req, res) => {
    const t = requireTenant(req);
    const workerId = String(req.body.workerId ?? `local_${t.id}`);
    let environment = req.body.environment;
    if (!environment) {
      try { environment = await detectLocalEnvironment(); } catch { environment = {}; }
    }
    workers.set(t.id, {
      workerId,
      tenantId: t.id,
      hostname: String(req.body.hostname ?? "desktop"),
      projectRoot: typeof req.body.projectRoot === "string" ? req.body.projectRoot : undefined,
      capabilities: Array.isArray(req.body.capabilities) ? req.body.capabilities : ["local_host"],
      environment,
      lastHeartbeat: Date.now(),
      status: req.body.degraded ? "degraded" : "ready",
      hostDesktopAllowed: req.body.hostDesktopAllowed === true,
    });
    res.json({ ok: true, workerId, secretRequired: true });
  });

  r.post("/heartbeat", (req, res) => {
    const t = requireTenant(req);
    const existing = workers.get(t.id);
    if (!existing) return res.status(404).json({ error: "Not registered — re-register" });
    existing.lastHeartbeat = Date.now();
    existing.status = req.body.degraded ? "degraded" : "ready";
    if (typeof req.body.projectRoot === "string") existing.projectRoot = req.body.projectRoot;
    existing.hostDesktopAllowed = req.body.hostDesktopAllowed === true;
    workers.set(t.id, existing);
    res.json({ ok: true, health: existing.status });
  });

  r.get("/health", (req, res) => {
    const t = requireTenant(req);
    res.json(localWorkerHealth(t.id));
  });

  r.get("/poll", (req, res) => {
    const t = requireTenant(req);
    const worker = workers.get(t.id);
    if (!worker || Date.now() - worker.lastHeartbeat >= 45_000) {
      return res.status(409).json({ error: "Local worker not registered" });
    }
    const job = jobs.find((j) => j.tenantId === t.id && !j.assignedTo);
    if (job) job.assignedTo = worker.workerId;
    res.json({ job: job ?? null });
  });

  r.get("/tools/:runId/next", (req, res) => {
    const t = requireTenant(req);
    const job = jobs.find((j) => j.runId === req.params.runId);
    if (job && job.tenantId !== t.id) return res.status(403).json({ error: "Not your run" });
    const request = toolRpc.poll(req.params.runId);
    let finished = false;
    try {
      const run = getRunStore(t.id).get(req.params.runId);
      finished = !!run && (run.status === "completed" || run.status === "error" || run.status === "cancelled");
    } catch { /* keep serving */ }
    if (finished) toolRpc.cleanup(req.params.runId);
    res.json({ request, finished, projectRoot: job?.projectRoot });
  });

  r.post("/tools/:runId/result", (req, res) => {
    requireTenant(req);
    const resolved = toolRpc.resolve({
      requestId: String(req.body.requestId ?? ""),
      runId: req.params.runId,
      ok: Boolean(req.body.ok),
      output: String(req.body.output ?? ""),
      stderr: req.body.stderr ? String(req.body.stderr) : undefined,
      exitCode: Number(req.body.exitCode ?? 0),
      error: req.body.error ? String(req.body.error) : undefined,
      durationMs: Number(req.body.durationMs ?? 0),
    });
    res.json({ ok: resolved });
  });

  r.post("/events/:runId", (req, res) => {
    const t = requireTenant(req);
    const { type, data } = req.body ?? {};
    if (!type) return res.status(400).json({ error: "type required" });
    try {
      const store = getRunStore(t.id);
      if (!store.get(req.params.runId)) store.create(req.params.runId, String(data?.projectRoot ?? t.currentProjectRoot ?? "/local"));
      const payload = { ...(data ?? {}) };
      // The worker does not know the model's call id. Attach the command that
      // is running now, so its output streams into the right row in the chat.
      if (String(type).startsWith("terminal.") && !payload.callId) {
        const callId = runningCommandCallId(store.get(req.params.runId)?.events ?? []);
        if (callId) payload.callId = callId;
      }
      store.emit(req.params.runId, type as AgentEventType, payload);
    } catch (err: any) {
      console.warn(`[local-worker] event persist failed: ${err.message}`);
    }
    res.json({ ok: true });
  });

  r.get("/processes", (req, res) => {
    const t = requireTenant(req);
    res.json({ processes: processTracker.list(typeof req.query.projectRoot === "string" ? req.query.projectRoot : t.currentProjectRoot ?? undefined) });
  });

  r.post("/execute", async (req, res) => {
    const t = requireTenant(req);
    const projectRoot = String(req.body.projectRoot ?? t.currentProjectRoot ?? "");
    if (!projectRoot) return res.status(400).json({ error: "projectRoot required" });
    const result = await executeLocalTool({
      tool: String(req.body.tool ?? ""),
      arguments: req.body.arguments ?? {},
      runId: typeof req.body.runId === "string" ? req.body.runId : undefined,
      projectRoot,
    });
    res.json(result);
  });

  return r;
}
