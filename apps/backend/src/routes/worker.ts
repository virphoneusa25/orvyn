import { asyncHandler } from "../http/asyncHandler";
// apps/backend/src/routes/worker.ts
//
// Worker-facing endpoints: registration, heartbeat, job polling, event
// relay (DURABLE — events flow into the tenant's RunStore), job submission.
// The worker authenticates with the same ORVYN_API_KEY as the desktop.

import { Router } from "express";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { RunStore } from "../agent/events";
import { isExecutionActive, isRunSettled } from "../agent/events";
import type { AgentEventType } from "../agent/events";
import { toolRpc } from "../execution/ToolRpc";
import { deleteWorkspacePaths, readWorkspaceTree, writeWorkspaceTree, type WorkspaceFile } from "../execution/workspaceSync";
import { assertWorkerCredential, resolveEventTenant, resolveWorkerTenant, type TenantResult } from "./workerTenant";
import { WORKER_STALE_MS, countOnlineWorkers, isWorkerOnline } from "./workerPresence";
import { sandboxRegistry, type SandboxRecord } from "../execution/sandbox/SandboxRegistry";
import { resourcesForPlan, selectSandbox, type PolicyTemplateId, type SandboxPlan } from "../execution/sandbox/selection";
import { credentialAllowed, pendingPolicyUpdate } from "../execution/sandbox/policyRequests";
import { creditLedger } from "../billing/AsyncFinancialStores";
import { WorkerAdmission } from "./workerAdmission";
import { LocalStore } from "../persistence/LocalStore";
import type { MissionCheckpoint } from "../agent/missionCheckpoint";
import { githubToken } from "../integrations/githubConnection";
import { deploymentCredential } from "../integrations/deploymentConnections";
import { sandboxTerminalBroker } from "../execution/SandboxTerminalBroker";
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
  /** Sandbox provider health and counters reported by the worker (admin only). */
  sandboxRuntime?: Record<string, any>;
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
  /** Durable project directory on the control plane. The worker sandbox is not this path. */
  canonicalProjectRoot?: string;
  assignedTo?: string;
  createdAt: number;
  /**
   * "executor": the control-plane ORION runtime owns the model loop and
   * completion; the worker only prepares the mission container and serves
   * tool RPC requests. This is the ONLY role new code may use — the legacy
   * worker-driven path must not come back.
   */
  role?: "executor";
  /** Execution sandbox plan (provider, policy template, plan-tier limits, retention). */
  sandbox?: SandboxPlan;
  /** Re-queued after the worker serving it died; the next worker reattaches. */
  recover?: boolean;
}

const workers = new Map<string, WorkerRecord>();
const jobQueue: PendingJob[] = [];
const jobAdmissions = new WorkerAdmission();

/** The run's durable mission checkpoint, when one was persisted for it. */
function missionCheckpointFor(tenantId: string, runId: string): MissionCheckpoint | null {
  try {
    return (new LocalStore(tenantId).loadMissionCheckpoint(runId) ?? null) as MissionCheckpoint | null;
  } catch {
    return null;
  }
}
/**
 * Boot-time recovery: a backend restart lost the in-memory job queue. Runs
 * whose journals replay with a live status are re-queued with recover=true
 * so the next worker reattaches to the sandbox and workspace bytes.
 */
async function recoverOrphanedRunsOnBoot(
  getStore: (tenantId?: string) => RunStore | Promise<RunStore>,
  resumeRun?: (tenantId: string, runId: string) => void | Promise<void>,
): Promise<void> {
  try {
    const dataDir = process.env.ORVYN_DATA_DIR || "";
    if (!dataDir) return;
    const dirs = fs.readdirSync(dataDir).filter((d) => d.startsWith("runs-"));
    let recovered = 0;
    for (const dir of dirs) {
      const tenantId = dir.replace(/^runs-/, "");
      const runDir = path.join(dataDir, dir);
      try {
        const journals = fs.readdirSync(runDir).filter((f) => f.endsWith(".jsonl"));
        for (const journal of journals) {
          const runId = journal.replace(/\.jsonl$/, "");
          try {
            const store = (await getStore(tenantId));
            const run = store.get(runId);
            if (!run) continue;
            if (isExecutionActive(run.status)) {
              const already = jobQueue.some((j) => j.runId === runId);
              if (already) continue;
              const record = sandboxRegistry().forRun(runId);
              // Recovery identity order — never fabricate org/user from the
              // tenant id: sandbox record → durable mission checkpoint →
              // block the run truthfully (it stays resumable via resume,
              // which re-derives real identity from the session).
              const cp = missionCheckpointFor(tenantId, runId);
              const source = record
                ? { organizationId: record.organizationId, userId: record.userId, projectId: record.projectId }
                : cp
                  ? { organizationId: cp.organizationId, userId: cp.userId, projectId: cp.projectId ?? null }
                  : null;
              if (!source?.organizationId || !source?.userId) {
                store.emit(runId, "run.blocked" as AgentEventType, { message: "The backend restarted, and this run's mission identity could not be recovered durably. Resume it to continue with its real identity.", resumable: true, reason: "identity_unrecoverable" });
                store.setStatus(runId, "blocked");
                continue;
              }
              const identity = assertTrustedMission({
                runId,
                tenantId: record?.tenantId ?? cp?.tenantId ?? tenantId,
                organizationId: source.organizationId,
                userId: source.userId,
                projectId: source.projectId ?? null,
              });
              rememberTenant(runId, tenantId, identity);
              const canonical = bindCanonicalRoot(runId, run.projectRoot || "");
              let recoveryBlocked = false;
              const plan: SandboxPlan | undefined = record ? {
                sandboxId: record.id,
                provider: record.provider,
                fallback: record.provider === "openshell" && String(process.env.ORVYN_EXECUTION_PROVIDER).toLowerCase() === "openshell" ? "none" : "docker",
                policyTemplate: record.policyTemplate as PolicyTemplateId,
                resources: resourcesForPlan((await creditLedger.planOf(tenantId))),
                retention: record.retention,
                credentials: [],
                reason: "backend restart recovery",
              } : (await (async () => {
                try {
                  return (await planSandbox(identity));
                } catch (err: any) {
                  // Mandatory-OpenShell deployments: a sandbox that cannot be
                  // planned blocks the run truthfully — it never rides a
                  // weaker provider the policy did not allow.
                  store.emit(runId, "run.blocked" as AgentEventType, { message: `Execution environment unavailable: ${String(err?.message ?? err).slice(0, 300)}`, resumable: true, reason: "sandbox_unavailable" });
                  store.setStatus(runId, "blocked");
                  recoveryBlocked = true;
                  return undefined;
                }
              })());
              if (recoveryBlocked) continue;
              jobQueue.push({
                runId,
                missionId: record?.missionId || `mission_${runId.slice(0, 8)}`,
                instruction: "",
                projectRoot: run.projectRoot || "",
                canonicalProjectRoot: canonical,
                tenantId,
                organizationId: identity.organizationId,
                userId: identity.userId,
                projectId: identity.projectId,
                workspace: missionWorkspacePath(WORKSPACE_ROOT, tenantId, plan?.retention === "retained" ? plan.sandboxId : runId),
                createdAt: Date.now(),
                role: "executor" as const,
                recover: true,
                ...(plan ? { sandbox: plan } : {}),
              });
              store.emit(runId, "agent.phase" as AgentEventType, { phase: "EXECUTE", note: "Control plane restarted — reconnecting to the mission workspace" });
              try {
                await resumeRun?.(tenantId, runId);
              } catch (error: any) {
                const queued = jobQueue.findIndex((job) => job.runId === runId);
                if (queued >= 0) jobQueue.splice(queued, 1);
                store.emit(runId, "run.error" as AgentEventType, { message: `Mission recovery failed: ${String(error?.message ?? error).slice(0, 300)}` });
                store.setStatus(runId, "error");
                continue;
              }
              recovered++;
            }
          } catch { /* individual run read failure is not fatal */ }
        }
      } catch { /* directory read failure is not fatal */ }
    }
    if (recovered > 0) console.log(`[worker-registry] boot recovery: re-queued ${recovered} orphaned run(s) after backend restart`);
  } catch (err) {
    console.warn("[worker-registry] boot recovery scan failed:", err);
  }
}
/** Tenant bound when a job was queued. Survives removal from the queue so late events still land in the right store. */
const runTenants = new Map<string, string>();
const runMissions = new Map<string, MissionIdentity>();
/** Run id → real path of the durable workspace on this control plane. */
const canonicalRoots = new Map<string, string>();
const WORKSPACE_ROOT = process.env.ORVYN_WORKSPACE_DIR || "/opt/orvyn/workspaces";

function bindCanonicalRoot(runId: string, candidate: string | undefined): string {
  const raw = String(candidate ?? "").trim();
  if (!raw) return "";
  try {
    if (!fs.existsSync(raw) || !fs.statSync(raw).isDirectory()) return "";
    const real = fs.realpathSync(raw);
    canonicalRoots.set(runId, real);
    return real;
  } catch {
    return "";
  }
}

/** Files the worker should stage. `canonical` is false when this run has no durable directory. */
export function listCanonicalFiles(runId: string): { canonical: boolean; files: WorkspaceFile[] } {
  const root = canonicalRoots.get(runId);
  if (!root) return { canonical: false, files: [] };
  return { canonical: true, files: readWorkspaceTree(root) };
}

/**
 * Write worker sandbox bytes back onto the durable workspace. `deleted` is
 * an explicit manifest of paths the worker removed — absence from `files`
 * alone never deletes a canonical file.
 */
export function applyCanonicalSync(runId: string, files: WorkspaceFile[], deleted?: string[]): { ok: true; written: string[]; deleted: string[] } | { ok: false; error: string } {
  const root = canonicalRoots.get(runId);
  if (!root) return { ok: false, error: "no canonical workspace for this run" };
  const written = writeWorkspaceTree(root, Array.isArray(files) ? files : []);
  const removed = Array.isArray(deleted) && deleted.length ? deleteWorkspacePaths(root, deleted) : [];
  return { ok: true, written, deleted: removed };
}

export function canonicalRootForRun(runId: string): string | undefined {
  return canonicalRoots.get(runId);
}

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
  return { online: countOnlineWorkers(workers.values()), total: workers.size };
}

/**
 * Queues an executor job. `projectRoot` is a path the worker may copy if it
 * exists on that machine. `canonicalProjectRoot` is the durable workspace on
 * this control plane (ORVYN_DATA_DIR). The worker stages that tree over HTTP
 * and syncs changes back before its sandbox is removed.
 */
export function queueExecutorJob(runId: string, projectRoot: string, identity?: Partial<MissionIdentity> | string, canonicalProjectRoot?: string, recover = false): Promise<void> {
  if (jobQueue.some((job) => job.runId === runId)) return Promise.resolve();
  return jobAdmissions.run(runId, async current => {
    if (!current()) return;
    const mission = assertTrustedMission({
      ...(typeof identity === "string" ? { tenantId: identity } : identity ?? {}),
      runId,
      organizationId: typeof identity === "string" ? identity : identity?.organizationId || identity?.tenantId || "",
      userId: typeof identity === "string" ? identity : identity?.userId || identity?.tenantId || "",
      tenantId: typeof identity === "string" ? identity : identity?.tenantId || "",
      projectId: typeof identity === "string" ? null : identity?.projectId ?? null,
    });
    rememberTenant(runId, mission.tenantId, mission);
    const canonical = bindCanonicalRoot(runId, canonicalProjectRoot || projectRoot);
    const sandbox = (await planSandbox(mission));
    if (!current() || jobQueue.some((job) => job.runId === runId)) return;
    jobQueue.push({
      runId,
      missionId: `mission_${runId.slice(0, 8)}`,
      instruction: "",
      projectRoot,
      canonicalProjectRoot: canonical,
      tenantId: mission.tenantId,
      organizationId: mission.organizationId,
      userId: mission.userId,
      projectId: mission.projectId,
      // A retained sandbox keeps one workspace directory per project across runs.
      workspace: missionWorkspacePath(WORKSPACE_ROOT, mission.tenantId, sandbox?.retention === "retained" ? sandbox.sandboxId : mission.runId),
      role: "executor",
      createdAt: Date.now(),
      ...(recover ? { recover: true } : {}),
      ...(sandbox ? { sandbox } : {}),
    });
  });
}

/**
 * Chooses and records the run's execution sandbox. The registry row exists
 * before any worker sees the job, so every sandbox has an owner on record.
 * A registry failure on a docker/auto deployment falls back to the legacy
 * Docker plan the worker derives on its own — but when the deployment
 * MANDATES OpenShell (ORVYN_EXECUTION_PROVIDER=openshell), a failure or
 * ineligible selection propagates so the run can block truthfully instead
 * of silently losing its isolation.
 */
async function planSandbox(mission: MissionIdentity): Promise<SandboxPlan | undefined> {
  // A failed financial read must block admission, never select a default resource plan.
  const planId = (await creditLedger.planOf(mission.tenantId)) ?? null;
  try {
    const plan = selectSandbox({
      organizationId: mission.organizationId, tenantId: mission.tenantId, projectId: mission.projectId,
      planId, runId: mission.runId, workspaceId: String(mission.projectId ?? mission.runId),
    }, sandboxRegistry());
    sandboxRegistry().plan({
      id: plan.sandboxId, provider: plan.provider, organizationId: mission.organizationId, tenantId: mission.tenantId,
      userId: mission.userId, projectId: mission.projectId, workspaceId: String(mission.projectId ?? mission.runId),
      runId: mission.runId, missionId: `mission_${mission.runId.slice(0, 8)}`, policyTemplate: plan.policyTemplate,
      retention: plan.retention, expiresAt: Date.now() + plan.resources.maxLifetimeS * 1000,
    });
    sandboxRegistry().audit("sandbox.planned", "control-plane", { sandboxId: plan.sandboxId, organizationId: mission.organizationId, detail: { provider: plan.provider, reason: plan.reason, retention: plan.retention, runId: mission.runId } });
    return plan;
  } catch (err: any) {
    if (String(process.env.ORVYN_EXECUTION_PROVIDER).toLowerCase() === "openshell") throw err;
    console.warn(`[worker-registry] sandbox plan failed for ${mission.runId}: ${String(err?.message ?? err).slice(0, 200)}`);
    return undefined;
  }
}

/** Removes a finished run's job so it no longer counts against the tenant's concurrency. */
function finishJob(runId: string): void {
  const job = jobQueue.find((j) => j.runId === runId);
  if (job) jobQueue.splice(jobQueue.indexOf(job), 1);
  try { sandboxRegistry().expireRequests(runId); } catch { /* registry unavailable */ }
  sandboxTerminalBroker.closeRun(runId);
}

/** Admin System Health: per-worker sandbox runtime reports (no secrets, no paths). */
export function workerRuntimeReports(): Array<{ workerId: string; status: string; lastHeartbeat: number; sandboxRuntime: Record<string, any> | null }> {
  pruneStaleWorkers();
  return [...workers.values()].map((w) => ({ workerId: w.workerId, status: w.status, lastHeartbeat: w.lastHeartbeat, sandboxRuntime: w.sandboxRuntime ?? null }));
}

/** Removes any queued job for the run and drops pending tool RPCs. */
export function cancelWorkerRun(runId: string): void {
  jobAdmissions.cancel(runId);
  const job = jobQueue.find((j) => j.runId === runId);
  if (job) jobQueue.splice(jobQueue.indexOf(job), 1);
  toolRpc.cancelRun(runId);
}

// Mark workers offline if heartbeat is stale (>45s)
function pruneStaleWorkers(): void {
  const cutoff = Date.now() - WORKER_STALE_MS;
  for (const [id, w] of workers) {
    if (w.lastHeartbeat < cutoff) {
      w.status = "offline";
    }
  }
}
setInterval(pruneStaleWorkers, 15_000).unref();

export function workerRouter(
  auth: (req: any) => any,
  getRunStore: (tenantId?: string) => RunStore | Promise<RunStore>,
  resumeRun?: (tenantId: string, runId: string) => void | Promise<void>,
): Router {
  const r = Router();

  const tenantExists =  async (id: string) => {
    try {
      (await getRunStore(id));
      return true;
    } catch {
      return false;
    }
  };

  const decide =  async (req: any, runId?: string, requested?: string): Promise<TenantResult> => {
    const caller = auth(req) as { id?: string };
    return (await resolveEventTenant({
      callerId: String(caller?.id ?? ""),
      jobTenantId: runId ? tenantForRun(runId) : undefined,
      requestedTenantId: requested,
      tenantExists,
    }));
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

  // Boot-time recovery: scan for orphaned runs 5s after startup.
  setTimeout(async () => (await recoverOrphanedRunsOnBoot(getRunStore, resumeRun)), 5_000).unref?.();

  // ── Worker loss → recovery ───────────────────────────────────────────
  // A job assigned to a worker that stopped heartbeating is re-queued with
  // recover=true while its run is still active. The next worker reattaches
  // to the same sandbox (it outlives the worker process) and the same
  // workspace bytes. Tool calls the dead worker had taken fail truthfully.
  const recoverOrphanedJobs =  async (): Promise<void> => {
    pruneStaleWorkers();
    for (const job of jobQueue) {
      if (!job.assignedTo) continue;
      const w = workers.get(job.assignedTo);
      if (w && isWorkerOnline(w)) continue;
      let active = false;
      try {
        const run = (await getRunStore(job.tenantId)).get(job.runId);
        // Only an execution-active run gets a replacement worker. A settled
        // run (partial/error/cancelled) is done, and a blocked one is paused
        // awaiting its blocker — not something to reattach a worker to.
        active = Boolean(run && isExecutionActive(run.status));
      } catch { active = false; }
      if (!active) { finishJob(job.runId); continue; }
      const lost = job.assignedTo;
      job.assignedTo = undefined;
      job.recover = true;
      const failed = toolRpc.failInFlight(job.runId, "The cloud worker running this step restarted before it finished. Check the workspace state (read the file / list the folder) before retrying.");
      try {
        (await getRunStore(job.tenantId)).emit(job.runId, "agent.phase" as AgentEventType, { phase: "EXECUTE", note: "Reconnecting to the mission workspace" });
        const rec = sandboxRegistry().forRun(job.runId);
        if (rec) {
          sandboxRegistry().report(rec.id, { state: "recovering" });
          sandboxRegistry().audit("sandbox.recovering", "control-plane", { sandboxId: rec.id, organizationId: rec.organizationId, detail: { lostWorker: lost, failedToolCalls: failed } });
        }
      } catch { /* best effort */ }
      console.warn(`[worker-registry] worker ${lost} lost; re-queued ${job.runId} for recovery (${failed} in-flight tool call(s) failed)`);
    }
  };
  setInterval(recoverOrphanedJobs, 20_000).unref();

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
    if (!isWorkerOnline(worker)) {
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

  // ── Canonical workspace: stage out, sync back ────────────────────────
  // The worker sandbox is ephemeral. These endpoints are the only copy
  // path for a remote worker that cannot see ORVYN_DATA_DIR.
  r.get("/workspace/:runId/files", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
    }
    res.json(listCanonicalFiles(req.params.runId));
  });

  r.post("/workspace/:runId/sync", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
    }
    const files = Array.isArray(req.body?.files) ? req.body.files as WorkspaceFile[] : [];
    const deleted = Array.isArray(req.body?.deleted) ? req.body.deleted.map((p: unknown) => String(p)) : undefined;
    const applied = applyCanonicalSync(req.params.runId, files, deleted);
    if (!applied.ok) return res.status(409).json(applied);
    res.json(applied);
  });

  // ── Interactive portal terminal relay ────────────────────────────────
  // Customer calls are tenant-bound. The worker only receives opaque
  // actions and returns terminal bytes; it never receives browser auth.
  r.post("/terminals/:runId/open", (req, res) => {
    const caller = auth(req) as { id?: string };
    const tenantId = String(caller?.id ?? "");
    if (!tenantId || tenantForRun(req.params.runId) !== tenantId) return res.status(404).json({ error: "Run not found" });
    const job = jobQueue.find((j) => j.runId === req.params.runId);
    if (!job?.assignedTo) return res.status(409).json({ error: "The sandbox is not ready yet" });
    const session = sandboxTerminalBroker.open(req.params.runId, tenantId, Number(req.body?.cols) || 120, Number(req.body?.rows) || 32);
    res.status(201).json({ sessionId: session.id });
  });

  r.post("/terminals/:sessionId/input", (req, res) => {
    const caller = auth(req) as { id?: string };
    const ok = sandboxTerminalBroker.input(req.params.sessionId, String(caller?.id ?? ""), String(req.body?.data ?? ""));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "Terminal not found" });
  });

  r.post("/terminals/:sessionId/resize", (req, res) => {
    const caller = auth(req) as { id?: string };
    const ok = sandboxTerminalBroker.resize(req.params.sessionId, String(caller?.id ?? ""), Number(req.body?.cols) || 120, Number(req.body?.rows) || 32);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "Terminal not found" });
  });

  r.post("/terminals/:sessionId/close", (req, res) => {
    const caller = auth(req) as { id?: string };
    const ok = sandboxTerminalBroker.close(req.params.sessionId, String(caller?.id ?? ""));
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: "Terminal not found" });
  });

  r.get("/terminals/:sessionId/output", (req, res) => {
    const caller = auth(req) as { id?: string };
    const out = sandboxTerminalBroker.read(req.params.sessionId, String(caller?.id ?? ""), Number(req.query.after) || 0);
    res.status(out ? 200 : 404).json(out ?? { error: "Terminal not found" });
  });

  r.get("/terminals/:runId/worker-next", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const job = jobQueue.find((j) => j.runId === req.params.runId);
    const workerId = String(req.query.workerId ?? "");
    if (!job || job.assignedTo !== workerId) return res.status(409).json({ error: "This run is not assigned to this worker" });
    res.json({ action: sandboxTerminalBroker.poll(req.params.runId) });
  });

  r.post("/terminals/:sessionId/worker-event", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const session = sandboxTerminalBroker.get(req.params.sessionId, String(tenantForRun(String(req.body?.runId ?? "")) ?? ""));
    const job = session ? jobQueue.find((j) => j.runId === session.runId) : undefined;
    if (!session || !job || job.assignedTo !== String(req.body?.workerId ?? "")) return res.status(409).json({ error: "Terminal is not assigned to this worker" });
    const type = String(req.body?.type ?? "") as "output" | "exit" | "error";
    if (!["output", "exit", "error"].includes(type)) return res.status(400).json({ error: "Invalid terminal event" });
    sandboxTerminalBroker.push(session.id, { type, data: String(req.body?.data ?? "").slice(0, 64_000), exitCode: Number(req.body?.exitCode ?? 0) });
    res.json({ ok: true });
  });

  // ── Tool RPC: worker polls for the next tool request ─────────────────
  // The response also tells the worker when the control-plane run has
  // finished, so it can collect artifacts and clean the container up. The
  // WORKER never decides completion — it only observes it here.
  r.get("/tools/:runId/next", asyncHandler(async (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
    }
    const workerId = String(req.query.workerId ?? "");
    const assigned = jobQueue.find((j) => j.runId === req.params.runId)?.assignedTo;
    const worker = workers.get(workerId);
    if (!workerId || !worker || worker.status === "offline" || assigned !== workerId) {
      return res.status(409).json({ error: "This run was reassigned to another worker (you were declared offline). Stop serving it." });
    }
    const request = toolRpc.poll(req.params.runId);
    let finished = false;
    try {
      const bound = tenantForRun(req.params.runId);
      const run = (await getRunStore(bound)).get(req.params.runId);
      finished = run ? isRunSettled(run.status) : false;
    } catch { /* store unavailable — keep serving */ }
    if (finished) {
      toolRpc.cleanup(req.params.runId);
      finishJob(req.params.runId);
    }
    let policyUpdate = null;
    if (!finished) {
      try { policyUpdate = pendingPolicyUpdate(sandboxRegistry(), req.params.runId); } catch { /* registry unavailable */ }
    }
    res.json({ request, finished, ...(policyUpdate ? { policyUpdate } : {}) });
  }));

  // ── Tool RPC: worker submits the tool result ──────────────────────────
  r.post("/tools/:runId/result", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    if (!bindWorkerRun(req.params.runId) && !tenantForRun(req.params.runId)) {
      return res.status(404).json({ error: "Not found" });
    }
    // Worker fencing: only the worker currently assigned to this run may
    // submit results. A zombie worker (declared dead, run reassigned,
    // process still alive) would corrupt the new worker's mission.
    {
      const workerId = String(req.body?.workerId ?? "");
      const assigned = jobQueue.find((j) => j.runId === req.params.runId)?.assignedTo;
      const worker = workers.get(workerId);
      if (!workerId || !worker || worker.status === "offline" || assigned !== workerId) {
        return res.status(409).json({ error: `This run was reassigned to another worker (you were declared offline). Stop serving it.` });
      }
    }
    const resolved = toolRpc.resolve({
      requestId: String(req.body.requestId ?? ""),
      runId: req.params.runId,
      ok: Boolean(req.body.ok),
      output: String(req.body.output ?? ""),
      stderr: req.body.stderr ? String(req.body.stderr) : undefined,
      exitCode: Number(req.body.exitCode ?? 0),
      error: req.body.error ? String(req.body.error) : undefined,
      meta: req.body.meta && typeof req.body.meta === "object" ? req.body.meta as Record<string, unknown> : undefined,
      durationMs: Number(req.body.durationMs ?? 0),
    });
    res.json({ ok: resolved });
  });

  // ── DURABLE event relay (workers push events → RunStore) ────────────
  // Events get authoritative sequence numbers, JSONL persistence, and
  // fan-out to SSE subscribers — identical to local run events.
  r.post("/events/:runId", asyncHandler(async (req, res) => {
    const { runId } = req.params;
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });
    const decision = (await decide(req, runId, typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined));
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });

    // Persist through the RunStore — durable + sequenced + replayable.
    // The tenant is the one recorded on the job, never a forged body field.
    try {
      const store = (await getRunStore(decision.tenantId));
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
  }));

  // ── Job submission (internal: the OVH provider calls this) ──────────
  r.post("/submit", asyncHandler(async (req, res) => {
    const { instruction, missionId, projectRoot, mode } = req.body;
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const caller = auth(req) as { id?: string };
    const decision = (await resolveWorkerTenant({
      callerId: String(caller?.id ?? ""),
      requestedTenantId: typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined,
      tenantExists,
    }));
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
    const canonical = bindCanonicalRoot(runId, String(req.body?.canonicalProjectRoot ?? projectRoot ?? ""));
    try {
      const store = (await getRunStore(tenantId));
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
      canonicalProjectRoot: canonical,
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
  }));

  // ── Execution sandbox registry (worker reports; admin-only detail) ──
  r.post("/sandboxes/:runId/report", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const runId = req.params.runId;
    if (!bindWorkerRun(runId) && !tenantForRun(runId)) return res.status(404).json({ error: "Not found" });
    const reg = sandboxRegistry();
    const b = req.body ?? {};
    const rec = reg.get(String(b.sandboxId ?? ""));
    // A report can only touch the sandbox recorded for this very run.
    if (!rec || rec.runId !== runId) return res.status(404).json({ error: "Not found" });
    if (b.fallbackTo === "docker" && rec.provider !== "docker") {
      reg.recordFallback(rec.id, "docker", String(b.fallbackReason ?? "unavailable"));
      reg.audit("sandbox.fallback", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId, detail: { reason: String(b.fallbackReason ?? "").slice(0, 200) } });
    }
    if (b.reconnect) { reg.bump(rec.id, "reconnects"); reg.audit("sandbox.reconnected", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId }); }
    if (b.policyDenied) { reg.bump(rec.id, "policyDenials"); reg.audit("network.denied", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId, detail: { kind: String(b.policyDenied) } }); }
    if (typeof b.execMs === "number") reg.addExec(rec.id, b.execMs);
    const patch: Partial<SandboxRecord> = {};
    if (typeof b.state === "string") patch.state = b.state as SandboxRecord["state"];
    if (typeof b.providerSandboxId === "string") patch.providerSandboxId = b.providerSandboxId.slice(0, 120);
    if (typeof b.workerId === "string") patch.workerId = b.workerId.slice(0, 120);
    if (typeof b.provisionMs === "number") patch.provisionMs = Math.round(b.provisionMs);
    if (typeof b.policyTemplate === "string") patch.policyTemplate = b.policyTemplate.slice(0, 40);
    if (typeof b.policyVersion === "number") patch.policyVersion = b.policyVersion;
    if (typeof b.lastError === "string") patch.lastError = b.lastError;
    if (typeof b.destroyedAt === "number") patch.destroyedAt = b.destroyedAt;
    if (Object.keys(patch).length) reg.report(rec.id, patch);
    if (b.state === "ready" && !b.released) reg.audit("sandbox.ready", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId, detail: { provisionMs: patch.provisionMs ?? null } });
    if (b.state === "failed") reg.audit("sandbox.failed", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId, detail: { error: String(b.lastError ?? "").slice(0, 200) } });
    if (typeof b.destroyedAt === "number") reg.audit("sandbox.destroyed", `worker:${String(b.workerId ?? "")}`, { sandboxId: rec.id, organizationId: rec.organizationId });
    res.json({ ok: true });
  });

  r.post("/sandboxes/:runId/policy/:requestId", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const reg = sandboxRegistry();
    const pr = reg.policyRequest(req.params.requestId);
    if (!pr || pr.runId !== req.params.runId) return res.status(404).json({ error: "Not found" });
    const ok = req.body?.ok === true;
    reg.markPolicyApplied(pr.id, ok);
    if (ok) reg.report(pr.sandboxId ?? "", { policyTemplate: pr.template });
    reg.audit(ok ? "policy.expansion.applied" : "policy.expansion.failed", "worker", { sandboxId: pr.sandboxId, organizationId: pr.organizationId, detail: { requestId: pr.id, template: pr.template, error: ok ? undefined : String(req.body?.error ?? "").slice(0, 200) } });
    res.json({ ok: true });
  });

  // Brokered credential for one run + one integration. Only for an OpenShell
  // sandbox whose approved template needs it; the value goes straight into
  // the gateway's credential store and never into the sandbox or any log.
  r.get("/credentials/:runId/:integrationId", asyncHandler(async (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const reg = sandboxRegistry();
    const allowed = credentialAllowed(reg, req.params.runId, req.params.integrationId);
    if (!allowed.ok) return res.status(403).json({ error: "Not permitted" });
    const credentials = req.params.integrationId === "github"
      ? await (async () => { const token = await githubToken(allowed.tenantId); return token ? { GITHUB_TOKEN: token, GH_TOKEN: token } : null; })()
      : await deploymentCredential(allowed.tenantId, req.params.integrationId);
    if (!credentials) return res.json({ credentials: null });
    reg.audit("credential.attached", "worker", { sandboxId: allowed.sandboxId, organizationId: allowed.organizationId, detail: { integrationId: req.params.integrationId } });
    res.json({ credentials });
  }));

  /** Sandbox ids still in use, for the worker's reconciliation pass. */
  r.get("/sandboxes/live", asyncHandler(async (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const reg = sandboxRegistry();
    const now = Date.now();
    const candidates = reg.active();
    const keep = await Promise.all(candidates.map(async (s) => {
      if (s.retention === "retained") return !s.expiresAt || s.expiresAt > now;
      const job = s.runId ? jobQueue.find((j) => j.runId === s.runId) : undefined;
      if (job) return true;
      try {
        const run = (await getRunStore(s.tenantId)).get(s.runId ?? "");
        return Boolean(run && run.status !== "completed" && run.status !== "error" && run.status !== "cancelled");
      } catch { return true; } // unknown → keep; never delete on doubt
    }));
    const live = candidates.filter((_s, i) => keep[i]).map((s) => s.id);
    res.json({ live });
  }));

  r.post("/sandboxes/reconciled", (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    const reg = sandboxRegistry();
    const removed: string[] = Array.isArray(req.body?.removed) ? req.body.removed.map(String).slice(0, 500) : [];
    for (const id of removed) {
      const rec = reg.get(id);
      if (rec && !["completed", "failed", "stopped"].includes(rec.state)) reg.report(id, { state: "stopped", destroyedAt: Date.now(), lastError: "removed by reconciliation" });
    }
    // Rows the worker never reported back on (a crash before destroy) are closed here.
    for (const rec of reg.staleCandidates(6 * 3600_000)) {
      if (rec.retention === "retained" && rec.expiresAt && rec.expiresAt > Date.now()) continue;
      reg.report(rec.id, { state: "stopped", lastError: "stale: no report for 6 h" });
    }
    if (removed.length) reg.audit("sandbox.reconciled", `worker:${String(req.body?.workerId ?? "")}`, { detail: { removed: removed.length, kept: Number(req.body?.kept ?? 0) } });
    res.json({ ok: true });
  });

  // ── Worker list (monitoring/debugging) ──────────────────────────────
  r.get("/list", (req, res) => {
    auth(req);
    pruneStaleWorkers();
    res.json({
      workers: [...workers.values()].map((w) => ({
        ...w,
        online: isWorkerOnline(w),
      })),
      queued: jobQueue.filter((j) => !j.assignedTo).length,
      online: countOnlineWorkers(workers.values()),
    });
  });

  // ── Cancel a remote run ──────────────────────────────────────────────
  // The worker POLLS this with GET while a mission runs: it must observe the
  // run's authoritative status (set by the control-plane runtime) so it can
  // kill the container the moment the user stops the run. The POST form is
  // the desktop-initiated cancel.
  r.get("/cancel/:runId", asyncHandler(async (req, res) => {
    if (denyUnlessWorker(req, res)) return;
    let cancelled = false;
    try {
      cancelled = (await getRunStore(tenantForRun(req.params.runId))).get(req.params.runId)?.status === "cancelled";
    } catch { /* store unavailable */ }
    res.json({ cancelled, stopRequested: cancelled });
  }));

  r.post("/cancel/:runId", asyncHandler(async (req, res) => {
    const { runId } = req.params;
    const decision = (await decide(req, runId, typeof req.body?.tenantId === "string" ? req.body.tenantId : undefined));
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });
    const job = jobQueue.find((j) => j.runId === runId);
    if (job) {
      jobQueue.splice(jobQueue.indexOf(job), 1);
    }
    toolRpc.cancelRun(runId);
    // Mark the run cancelled in the RunStore (durable event) — unless the
    // control-plane runtime already reached a terminal state of its own.
    try {
      const store = (await getRunStore(decision.tenantId));
      const run = store.get(runId);
      if (run && run.status !== "completed" && run.status !== "error" && run.status !== "cancelled") {
        store.emit(runId, "run.cancelled" as AgentEventType, { reason: "Stopped by user" });
        store.setStatus(runId, "cancelled");
      }
    } catch { /* best-effort */ }
    res.json({ ok: true, cancelled: true });
  }));

  return r;
}
