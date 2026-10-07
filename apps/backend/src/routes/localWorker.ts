import { asyncHandler } from "../http/asyncHandler";
// User-scoped local worker: the desktop process registers as this tenant's
// local_host executor. ToolGateway on the control plane still authorizes
// every call; this only serves Tool RPC against the opened project root.

import { Router } from "express";
import { toolRpc } from "../execution/ToolRpc";
import { detectLocalEnvironment } from "../localWorker/environmentDetect";
import type { ServiceRecord } from "../services/ServiceManager";
import { noteWorkbenchBrowser, resolveWorkbenchBrowserCommand, takeWorkbenchBrowserCommands } from "../desktop/workbenchBrowserBridge";
import type { AgentEventType } from "../agent/events";
import type { RunStore } from "../agent/events";
import { isRunSettled } from "../agent/events";
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
  /** Services running on the user's computer, as the worker last reported them. */
  services: ServiceRecord[];
}

const workers = new Map<string, LocalWorkerRecord>();
/** Stop requests from the app, handed to the worker on its next poll. */
const pendingStops = new Map<string, Set<string>>();

const SERVICE_FIELDS = ["serviceId", "name", "command", "cwd", "projectRoot", "runId", "port", "url", "status", "startedAt", "readyAt", "lastHealthAt", "exitCode", "stopReason"] as const;

function cleanServices(raw: unknown): ServiceRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((item) => {
    if (!item || typeof item !== "object" || typeof (item as any).serviceId !== "string") return [];
    const out: Record<string, unknown> = {};
    for (const k of SERVICE_FIELDS) if ((item as any)[k] !== undefined) out[k] = (item as any)[k];
    return [out as unknown as ServiceRecord];
  });
}

/** Services on this tenant's computer (empty when the Local Worker is offline). */
export function localWorkerServices(tenantId: string): ServiceRecord[] {
  return hasOnlineLocalWorker(tenantId) ? workers.get(tenantId)?.services ?? [] : [];
}

/** Queues a stop for a service on the user's computer. False if it is unknown. */
export function requestLocalServiceStop(tenantId: string, serviceId: string): boolean {
  const w = workers.get(tenantId);
  const svc = w?.services.find((s) => s.serviceId === serviceId);
  if (!w || !svc) return false;
  const set = pendingStops.get(tenantId) ?? new Set<string>();
  set.add(serviceId);
  pendingStops.set(tenantId, set);
  svc.status = "stopped";
  svc.stopReason = "stopping (requested in ORVYN)";
  return true;
}

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

/** A queued local job no worker has picked up (the worker that registered is gone). */
export function localJobUnclaimed(runId: string): boolean {
  const job = jobs.find((j) => j.runId === runId);
  return Boolean(job && !job.assignedTo);
}

/** Drops a queued local job so a late worker does not run it twice. */
export function dropLocalJob(runId: string): void {
  const i = jobs.findIndex((j) => j.runId === runId && !j.assignedTo);
  if (i >= 0) jobs.splice(i, 1);
}

export function queueLocalHostJob(runId: string, projectRoot: string, tenantId: string, role: "local_host" | "local_sandbox" = "local_host"): void {
  jobs.push({ runId, tenantId, projectRoot, role, createdAt: Date.now() });
}

export function localWorkerRouter(
  requireTenant: (req: any) => Tenant,
  getRunStore: (tenantId: string) => RunStore | Promise<RunStore>
): Router {
  const r = Router();

  r.post("/register", asyncHandler(async (req, res) => {
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
      services: cleanServices(req.body.services),
    });
    noteWorkbenchBrowser(t.id, Array.isArray(req.body.capabilities) && req.body.capabilities.includes("workbench-browser"));
    res.json({ ok: true, workerId, secretRequired: true });
  }));

  r.post("/heartbeat", (req, res) => {
    const t = requireTenant(req);
    const existing = workers.get(t.id);
    if (!existing) return res.status(404).json({ error: "Not registered — re-register" });
    existing.lastHeartbeat = Date.now();
    existing.status = req.body.degraded ? "degraded" : "ready";
    if (typeof req.body.projectRoot === "string") existing.projectRoot = req.body.projectRoot;
    existing.hostDesktopAllowed = req.body.hostDesktopAllowed === true;
    if (Array.isArray(req.body.services)) existing.services = cleanServices(req.body.services);
    workers.set(t.id, existing);
    if (existing.capabilities.includes("workbench-browser")) noteWorkbenchBrowser(t.id, true);
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
    const stops = [...(pendingStops.get(t.id) ?? [])];
    pendingStops.delete(t.id);
    const browser = worker.capabilities.includes("workbench-browser");
    if (browser) noteWorkbenchBrowser(t.id, true);
    res.json({ job: job ?? null, stopServices: stops, browserCommands: browser ? takeWorkbenchBrowserCommands(t.id) : [] });
  });

  r.get("/tools/:runId/next", asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const job = jobs.find((j) => j.runId === req.params.runId);
    if (job && job.tenantId !== t.id) return res.status(403).json({ error: "Not your run" });
    const request = toolRpc.poll(req.params.runId);
    let finished = false;
    let cancelled = false;
    try {
      const run = (await getRunStore(t.id)).get(req.params.runId);
      finished = !!run && isRunSettled(run.status);
      cancelled = run?.status === "cancelled";
    } catch { /* keep serving */ }
    if (finished) toolRpc.cleanup(req.params.runId);
    res.json({ request, finished, cancelled, projectRoot: job?.projectRoot });
  }));

  r.get("/tools/:runId/state", asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const job = jobs.find((j) => j.runId === req.params.runId);
    if (!job || job.tenantId !== t.id) return res.status(403).json({ error: "Not your run" });
    const run = (await getRunStore(t.id)).get(req.params.runId);
    res.json({ cancelled: run?.status === "cancelled", finished: Boolean(run && isRunSettled(run.status)) });
  }));

  r.post("/tools/:runId/result", (req, res) => {
    const t = requireTenant(req);
    const job = jobs.find((j) => j.runId === req.params.runId);
    if (job && job.tenantId !== t.id) return res.status(403).json({ error: "Not your run" });
    // Fence late results: only the worker this job was assigned to may
    // resolve its ToolRPC — a re-registered process must not answer for a
    // stale assignment (same rule the cloud worker route enforces).
    const workerId = String(req.body.workerId ?? "");
    if (job?.assignedTo && workerId && job.assignedTo !== workerId) {
      return res.status(409).json({ error: "This run is assigned to another worker" });
    }
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

  r.post("/events/:runId", asyncHandler(async (req, res) => {
    const t = requireTenant(req);
    const { type, data } = req.body ?? {};
    if (!type) return res.status(400).json({ error: "type required" });
    try {
      const store = (await getRunStore(t.id));
      // The run's project root comes from the JOB that owns this run (or the
      // event payload) — never the tenant-global currentProjectRoot, which can
      // point at a different project when runs overlap.
      const jobRoot = jobs.find((j) => j.runId === req.params.runId)?.projectRoot;
      if (!store.get(req.params.runId)) store.create(req.params.runId, String(data?.projectRoot ?? jobRoot ?? "/local"));
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
  }));

  // The desktop's answer to one browser command (see workbenchBrowserBridge).
  r.post("/browser/:id/result", (req, res) => {
    const t = requireTenant(req);
    res.json({ ok: resolveWorkbenchBrowserCommand(t.id, String(req.params.id), req.body?.result) });
  });

  // The worker reports its services after any change, between heartbeats.
  r.post("/services", (req, res) => {
    const t = requireTenant(req);
    const existing = workers.get(t.id);
    if (!existing) return res.status(404).json({ error: "Not registered — re-register" });
    existing.services = cleanServices(req.body.services);
    res.json({ ok: true });
  });

  // NOTE: there is deliberately no direct /execute endpoint. Every tool call
  // a local worker runs must arrive as a ToolRPC request the control plane
  // already authorized through ToolGateway (permission → approval → workspace
  // binding). A tenant-authenticated "run this tool at this path" route would
  // be a bypass around all of it, so the worker protocol is poll → next →
  // result only.

  return r;
}
