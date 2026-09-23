// apps/backend/src/routes/worker.ts
//
// Worker-facing endpoints: registration, heartbeat, job polling, event
// relay (DURABLE — events flow into the tenant's RunStore), job submission.
// The worker authenticates with the same ORVYN_API_KEY as the desktop.

import { Router } from "express";
import { randomUUID } from "crypto";
import type { RunStore } from "../agent/events";
import type { AgentEventType } from "../agent/events";
import { toolRpc } from "../execution/ToolRpc";
import { assertWorkerCredential, resolveEventTenant, resolveWorkerTenant, type TenantResult } from "./workerTenant";
import {
  assertTrustedMission,
  countActiveByTenant,
  missionWorkspacePath,
  pickFairJob,
  type MissionIdentity,
} from "../identity/mission";

interface WorkerRecord {
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

interface PendingJob {
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
  assignedTo?: string;
  createdAt: number;
  /**
   * "executor": the control-plane ORION runtime owns the model loop and
   * completion; the worker only prepares the mission container and serves
   * tool RPC requests. This is the ONLY role new code may use — the legacy
   * worker-driven path must not come back.
   */
  role?: "executor";
}

const workers = new Map<string, WorkerRecord>();
const jobQueue: PendingJob[] = [];
/** Tenant bound when a job was queued. Survives removal from the queue so late events still land in the right store. */
const runTenants = new Map<string, string>();
const runMissions = new Map<string, MissionIdentity>();
const WORKSPACE_ROOT = process.env.ORVYN_WORKSPACE_DIR || "/opt/orvyn/workspaces";

function rememberTenant(runId: string, tenantId?: string, identity?: MissionIdentity): void {
  if (tenantId) runTenants.set(runId, tenantId);
  if (identity) runMissions.set(runId, identity);
}

function tenantForRun(runId: string): string | undefined {
  return jobQueue.find((j) => j.runId === runId)?.tenantId ?? runTenants.get(runId);
}

function missionForRun(runId: string): MissionIdentity | undefined {
  return runMissions.get(runId);
}

function bindWorkerRun(runId: string): MissionIdentity | undefined {
  return missionForRun(runId);
}

/** True when at least one worker has heartbeated within the stale window. */
export function hasOnlineWorker(): boolean {
  return workerStats().online > 0;
}

/** Real worker registry stats for health reporting — never a stub count. */
export function workerStats(): { online: number; total: number } {
  const cutoff = Date.now() - 45_000;
  let online = 0;
  for (const w of workers.values()) {
    if (w.status !== "offline" && w.lastHeartbeat >= cutoff) online++;
  }
  return { online, total: workers.size };
}

/**
 * Queues an executor job: the worker prepares an isolated mission container
 * for `runId` (transferring the project from its local `projectRoot`) and
 * then serves tool RPC requests until the control-plane run finishes.
 */
export function queueExecutorJob(runId: string, projectRoot: string, identity?: Partial<MissionIdentity> | string): void {
  const mission = assertTrustedMission({
    ...(typeof identity === "string" ? { tenantId: identity } : identity ?? {}),
    runId,
    organizationId: typeof identity === "string" ? identity : identity?.organizationId || identity?.tenantId || "",
    userId: typeof identity === "string" ? identity : identity?.userId || identity?.tenantId || "",
    tenantId: typeof identity === "string" ? identity : identity?.tenantId || "",
    projectId: typeof identity === "string" ? null : identity?.projectId ?? null,
  });
  rememberTenant(runId, mission.tenantId, mission);
  jobQueue.push({
    runId,
    missionId: `mission_${runId.slice(0, 8)}`,
    instruction: "",
    projectRoot,
    tenantId: mission.tenantId,
    organizationId: mission.organizationId,
    userId: mission.userId,
    projectId: mission.projectId,
    workspace: missionWorkspacePath(WORKSPACE_ROOT, mission.tenantId, mission.runId),
    role: "executor",
    createdAt: Date.now(),
  });
}

/** Removes any queued job for the run and drops pending tool RPCs. */
export function cancelWorkerRun(runId: string): void {
  const job = jobQueue.find((j) => j.runId === runId);
  if (job) jobQueue.splice(jobQueue.indexOf(job), 1);
  toolRpc.cancelRun(runId);
}

// Mark workers offline if heartbeat is stale (>45s)
function pruneStaleWorkers(): void {
  const cutoff = Date.now() - 45_000;
  for (const [id, w] of workers) {
    if (w.lastHeartbeat < cutoff) {
      w.status = "offline";
    }
  }
}
setInterval(pruneStaleWorkers, 15_000).unref();

export function workerRouter(
  auth: (req: any) => any,
  getRunStore: (tenantId?: string) => RunStore
): Router {
  const r = Router();

  const tenantExists = (id: string) => {
    try {
      getRunStore(id);
      return true;
    } catch {
      return false;
    }
  };

  const decide = (req: any, runId?: string, requested?: string): TenantResult => {
    const caller = auth(req) as { id?: string };
    return resolveEventTenant({
      callerId: String(caller?.id ?? ""),
      jobTenantId: runId ? tenantForRun(runId) : undefined,
      requestedTenantId: requested,
      tenantExists,
    });
  };

  const denyUnlessWorker = (req: any, res: any): boolean => {
    const caller = auth(req) as { id?: string };
    const gate = assertWorkerCredential(String(caller?.id ?? ""));
    if (!gate.ok) {
      res.status(gate.status).json({ error: gate.error });
      return true;
    }
    return false;
  };

  // ── Registration ─────────────────────────────────────────────────────
  r.post("/register", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const info = req.body as WorkerRecord;
    if (!info.workerId) return res.status(400).json({ error: "workerId required" });
    workers.set(info.workerId, { ...info, lastHeartbeat: Date.now() });
    console.log(`[worker-registry] registered ${info.workerId} (${info.hostname}) — ${workers.size} workers`);
    res.json({ ok: true, workerId: info.workerId });
  });

  // ── Heartbeat ────────────────────────────────────────────────────────
  r.post("/heartbeat", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const info = req.body as WorkerRecord;
    const existing = workers.get(info.workerId);
    if (!existing) return res.status(404).json({ error: "Not registered — re-register" });
    workers.set(info.workerId, { ...info, lastHeartbeat: Date.now() });
    res.json({ ok: true });
  });

  // ── Job poll (workers pull) ──────────────────────────────────────────
  r.get("/poll", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const workerId = String(req.query.workerId ?? "");
    const worker = workers.get(workerId);
    if (!worker || worker.status === "offline") {
      return res.status(409).json({ error: "Worker not registered or offline" });
    }
    const eligible = jobQueue.filter((j): j is PendingJob & { tenantId: string } => Boolean(j.tenantId));
    const job = pickFairJob(eligible, countActiveByTenant(eligible));
    if (job) {
      job.assignedTo = workerId;
      res.json({ job: { ...job, identity: missionForRun(String(job.runId)) ?? null } });
    } else {
      res.json({ job: null });
    }
  });

  // ── Tool RPC: worker polls for the next tool request ─────────────────
  // The response also tells the worker when the control-plane run has
  // finished, so it can collect artifacts and clean the container up. The
  // WORKER never decides completion — it only observes it here.
  r.get("/tools/:runId/next", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
    }
    const request = toolRpc.poll(req.params.runId);
    let finished = false;
    try {
      const bound = tenantForRun(req.params.runId);
      const run = getRunStore(bound).get(req.params.runId);
      finished = run
        ? run.status === "completed" || run.status === "error" || run.status === "cancelled"
        : false;
    } catch { /* store unavailable — keep serving */ }
    if (finished) toolRpc.cleanup(req.params.runId);
    res.json({ request, finished });
  });

  // ── Tool RPC: worker submits the tool result ──────────────────────────
  r.post("/tools/:runId/result", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
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

  // ── DURABLE event relay (workers push events → RunStore) ────────────
  // Events get authoritative sequence numbers, JSONL persistence, and
  // fan-out to SSE subscribers — identical to local run events.
  r.post("/events/:runId", (req, res) => {
    const { runId } = req.params;
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });
    const decision = decide(req, runId, typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });

    // Persist through the RunStore — durable + sequenced + replayable.
    // The tenant is the one recorded on the job, never a forged body field.
    try {
      const store = getRunStore(decision.tenantId);
      const run = store.get(runId);
      if (!run) {
        // Remote run not yet in the RunStore — create it so events persist.
        store.create(runId, String(data?.projectRoot ?? "/remote"));
      }
      store.emit(runId, type as AgentEventType, data ?? {});
      // The worker stopping the container fails any tool RPC still waiting
      // on it — fast and truthful, instead of burning the full timeout.
      if (type === "sandbox.stopped") {
        toolRpc.failRun(runId, `The worker stopped the mission container (${String(data?.reason ?? "unknown reason")}) before this tool completed.`);
      }
    } catch (err: any) {
      // Event persistence failure should NOT block the worker — log it.
      console.warn(`[worker-relay] event store error for ${runId}: ${err.message}`);
    }

    res.json({ ok: true });
  });

  // ── Job submission (internal: the OVH provider calls this) ──────────
  r.post("/submit", (req, res) => {
    const { instruction, missionId, projectRoot, mode } = req.body;
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const caller = auth(req) as { id?: string };
    const decision = resolveWorkerTenant({
      callerId: String(caller?.id ?? ""),
      requestedTenantId: typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined,
      tenantExists,
    });
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    const tenantId = decision.tenantId;
    const runId = randomUUID();
    const mission = assertTrustedMission({
      tenantId,
      organizationId: typeof req.body?.organizationId === "string" && req.body.organizationId ? req.body.organizationId : tenantId,
      userId: typeof req.body?.userId === "string" && req.body.userId ? req.body.userId : tenantId,
      projectId: typeof req.body?.projectId === "string" ? req.body.projectId : null,
      runId,
    });

    rememberTenant(runId, tenantId, mission);
    try {
      const store = getRunStore(tenantId);
      if (!store.get(runId)) {
        store.create(runId, String(projectRoot ?? "/remote"));
        store.emit(runId, "run.started" as AgentEventType, { instruction, mode: mode || "agent", executionLocation: "OVH_WORKER" });
      }
    } catch { /* store may not be available — events will still relay */ }

    const job: PendingJob = {
      runId,
      missionId: missionId || `mission_${Date.now().toString(36)}`,
      instruction,
      projectRoot,
      mode,
      tenantId: mission.tenantId,
      organizationId: mission.organizationId,
      userId: mission.userId,
      projectId: mission.projectId,
      workspace: missionWorkspacePath(WORKSPACE_ROOT, mission.tenantId, mission.runId),
      createdAt: Date.now(),
    };
    jobQueue.push(job);
    res.status(201).json({ runId: job.runId, missionId: job.missionId, workspace: job.workspace, tenantId: mission.tenantId });
  });

  // ── Worker list (monitoring/debugging) ──────────────────────────────
  r.get("/list", (req, res) => {
    auth(req);
    pruneStaleWorkers();
    res.json({
      workers: [...workers.values()],
      queued: jobQueue.filter((j) => !j.assignedTo).length,
    });
  });

  // ── Cancel a remote run ──────────────────────────────────────────────
  // The worker POLLS this with GET while a mission runs: it must observe the
  // run's authoritative status (set by the control-plane runtime) so it can
  // kill the container the moment the user stops the run. The POST form is
  // the desktop-initiated cancel.
  r.get("/cancel/:runId", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    let cancelled = false;
    try {
      cancelled = getRunStore(tenantForRun(req.params.runId)).get(req.params.runId)?.status === "cancelled";
    } catch { /* store unavailable */ }
    res.json({ cancelled, stopRequested: cancelled });
  });

  r.post("/cancel/:runId", (req, res) => {
    const { runId } = req.params;
    const decision = decide(req, runId, typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    const job = jobQueue.find((j) => j.runId === runId);
    if (job) {
      jobQueue.splice(jobQueue.indexOf(job), 1);
    }
    toolRpc.cancelRun(runId);
    // Mark the run cancelled in the RunStore (durable event) — unless the
    // control-plane runtime already reached a terminal state of its own.
    try {
      const store = getRunStore(decision.tenantId);
      const run = store.get(runId);
      if (run && run.status !== "completed" && run.status !== "error" && run.status !== "cancelled") {
        store.emit(runId, "run.cancelled" as AgentEventType, { reason: "Stopped by user" });
        store.setStatus(runId, "cancelled");
      }
    } catch { /* best-effort */ }
    res.json({ ok: true, cancelled: true });
  });

  return r;
}
