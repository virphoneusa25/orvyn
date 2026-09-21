// apps/backend/src/routes/worker.ts
//
// Worker-facing endpoints: registration, heartbeat, job polling, event
// relay. The worker authenticates with the same ORVYN_API_KEY as the
// desktop. These endpoints are the bridge between the control plane and
// remote execution — no second event protocol.

import { Router } from "express";
import { randomUUID } from "crypto";

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
  assignedTo?: string;
  createdAt: number;
}

const workers = new Map<string, WorkerRecord>();
const jobQueue: PendingJob[] = [];
const runEventRelay = new Map<string, (event: { type: string; data: Record<string, unknown> }) => void>();

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

export function workerRouter(auth: (req: any) => any): Router {
  const r = Router();

  // ── Registration ─────────────────────────────────────────────────────
  r.post("/register", (req, res) => {
    auth(req); // 401 if invalid key
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
    // Find an unassigned job this worker can handle
    const job = jobQueue.find((j) => !j.assignedTo);
    if (job) {
      job.assignedTo = workerId;
      res.json({ job });
    } else {
      res.json({ job: null });
    }
  });

  // ── Event relay (workers push events for a run) ─────────────────────
  r.post("/events/:runId", (req, res) => {
    auth(req);
    const { runId } = req.params;
    const { type, data } = req.body;
    if (!type) return res.status(400).json({ error: "type required" });

    // Forward to any SSE subscriber for this run
    const listener = runEventRelay.get(runId);
    if (listener) listener({ type, data });

    // TODO: store in the durable event log when PG-backed persistence lands
    res.json({ ok: true });
  });

  // ── Job submission (internal: the OVH provider calls this) ──────────
  r.post("/submit", (req, res) => {
    auth(req);
    const { instruction, missionId, projectRoot, mode } = req.body;
    if (!instruction) return res.status(400).json({ error: "instruction required" });
    const job: PendingJob = {
      runId: randomUUID(),
      missionId: missionId || `mission_${Date.now().toString(36)}`,
      instruction,
      projectRoot,
      mode,
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
    const job = jobQueue.find((j) => j.runId === req.params.runId);
    if (job) {
      jobQueue.splice(jobQueue.indexOf(job), 1);
      res.json({ ok: true, cancelled: true });
    } else {
      res.json({ ok: true, cancelled: false, note: "job not found in queue (may be running)" });
    }
  });

  return r;
}
