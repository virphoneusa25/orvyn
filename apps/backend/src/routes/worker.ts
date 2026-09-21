// apps/backend/src/routes/worker.ts
//
// Worker-facing endpoints: registration, heartbeat, job polling, event
// relay (DURABLE — events flow into the tenant's RunStore), job submission.
// The worker authenticates with the same ORVYN_API_KEY as the desktop.

import { Router } from "express";
import { randomUUID } from "crypto";
import type { RunStore } from "../agent/events";
import type { AgentEventType } from "../agent/events";

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
  assignedTo?: string;
  createdAt: number;
}

const workers = new Map<string, WorkerRecord>();
const jobQueue: PendingJob[] = [];

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

  // ── Registration ─────────────────────────────────────────────────────
  r.post("/register", (req, res) => {
    auth(req);
    const info = req.body as WorkerRecord;
    if (!info.workerId) return res.status(400).json({ error: "workerId required" });
    workers.set(info.workerId, { ...info, lastHeartbeat: Date.now() });
    console.log(`[worker-registry] registered ${info.workerId} (${info.hostname}) — ${workers.size} workers`);
    res.json({ ok: true, workerId: info.workerId });
  });

  // ── Heartbeat ────────────────────────────────────────────────────────
  r.post("/heartbeat", (req, res) => {
    auth(req);
    const info = req.body as WorkerRecord;
    const existing = workers.get(info.workerId);
    if (!existing) return res.status(404).json({ error: "Not registered — re-register" });
    workers.set(info.workerId, { ...info, lastHeartbeat: Date.now() });
    res.json({ ok: true });
  });

  // ── Job poll (workers pull) ──────────────────────────────────────────
  r.get("/poll", (req, res) => {
    auth(req);
    const workerId = String(req.query.workerId ?? "");
    const worker = workers.get(workerId);
    if (!worker || worker.status === "offline") {
      return res.status(409).json({ error: "Worker not registered or offline" });
    }
    const job = jobQueue.find((j) => !j.assignedTo);
    if (job) {
      job.assignedTo = workerId;
      res.json({ job });
    } else {
      res.json({ job: null });
    }
  });

  // ── DURABLE event relay (workers push events → RunStore) ────────────
  // Events get authoritative sequence numbers, JSONL persistence, and
  // fan-out to SSE subscribers — identical to local run events.
  r.post("/events/:runId", (req, res) => {
    auth(req);
    const { runId } = req.params;
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });

    // Persist through the RunStore — durable + sequenced + replayable.
    // The tenant's RunStore is resolved from the job (or default tenant).
    try {
      const store = getRunStore(req.body.tenantId);
      const run = store.get(runId);
      if (!run) {
        // Remote run not yet in the RunStore — create it so events persist.
        store.create(runId, String(data?.projectRoot ?? "/remote"));
      }
      store.emit(runId, type as AgentEventType, data ?? {});
    } catch (err: any) {
      // Event persistence failure should NOT block the worker — log it.
      console.warn(`[worker-relay] event store error for ${runId}: ${err.message}`);
    }

    res.json({ ok: true });
  });

  // ── Job submission (internal: the OVH provider calls this) ──────────
  r.post("/submit", (req, res) => {
    auth(req);
    const { instruction, missionId, projectRoot, mode, tenantId } = req.body;
    if (!instruction) return res.status(400).json({ error: "instruction required" });

    // Create the run in the RunStore FIRST so events have a home.
    const runId = randomUUID();
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
      tenantId,
      createdAt: Date.now(),
    };
    jobQueue.push(job);
    res.status(201).json({ runId: job.runId, missionId: job.missionId });
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
  r.post("/cancel/:runId", (req, res) => {
    auth(req);
    const { runId } = req.params;
    const job = jobQueue.find((j) => j.runId === runId);
    if (job) {
      jobQueue.splice(jobQueue.indexOf(job), 1);
    }
    // Mark the run cancelled in the RunStore (durable event).
    try {
      const store = getRunStore(req.body?.tenantId);
      const run = store.get(runId);
      if (run) {
        store.emit(runId, "run.cancelled" as AgentEventType, { reason: "Stopped by user" });
        store.setStatus(runId, "cancelled");
      }
    } catch { /* best-effort */ }
    res.json({ ok: true, cancelled: true });
  });

  return r;
}
