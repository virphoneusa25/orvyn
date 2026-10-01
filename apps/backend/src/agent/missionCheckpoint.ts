// apps/backend/src/agent/missionCheckpoint.ts
//
// Durable mission state. Events are the audit trail; a MissionCheckpoint is
// the RESUME record — enough state for a new worker (or a restarted control
// plane) to continue the same mission without redoing finished work:
//
//   checkpoint → select a compatible fallback → same mission → same workspace
//   → same sandbox where possible → resume the current step
//
// Persisted through LocalStore (per-tenant SQLite) after meaningful steps:
// phase changes, completed tool batches, verification results, settlement.
// On boot, a non-terminal run with a checkpoint is resumable — it is not a
// dead "error" ghost.

import type { RunPhase } from "./agentRunState";

export interface CheckpointPlanStep {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  dependsOn?: string[];
}

/**
 * A checkpoint-safe plan: the runtime's strategy sketch plus any concrete
 * step list (plan.created), with per-step status recovered from task events.
 * Recovery reads this to know what finished and what remains — `unknown`
 * here was the old contract and made that impossible.
 */
export interface CheckpointPlan {
  strategy?: {
    objective?: string;
    filesToInspect: string[];
    likelyFilesToEdit: string[];
    verification: string[];
    risks: string[];
  };
  steps: CheckpointPlanStep[];
}

export interface CheckpointError {
  tool: string;
  error: string;
  /** The typed error class from toolErrors.ts (fixable/retryable/…/fatal). */
  errorClass?: string;
  at: number;
  /**
   * A later tool.completed for the same tool marks this resolved — the
   * resumed model should not re-fix a problem the run already repaired.
   */
  resolved?: boolean;
}

/** A file change with its operation — a bare path loses delete/move meaning. */
export interface CheckpointFileChange {
  path: string;
  operation: "create" | "modify" | "delete" | "move";
  /** move destination */
  destination?: string;
}

export interface CheckpointEvidence {
  /** The independent verifier's latest verdict, when it ran. */
  verifierVerdict?: string;
  /** check name → pass/fail/skip/unverified */
  checks: Record<string, string>;
  /** Canonical preview URL this mission verified against, when one exists. */
  previewUrl?: string;
  /** Preview state: URL plus its last known status and revision marker. */
  preview?: { url: string; revision?: number; status?: "active" | "verified" | "failed" };
  /** Event sequence of the last verification — freshness vs. lastChangeSequence. */
  verificationSequence?: number;
  /** Event sequence of the last file change. verification < lastChange ⇒ verify again. */
  lastChangeSequence?: number;
}

export interface MissionCheckpoint {
  runId: string;
  objective: string;
  plan: CheckpointPlan | null;
  /** Explicit work-done state — recovery should not parse prose to find it. */
  progress: {
    currentStepId?: string;
    currentTaskId?: string;
    currentAction?: string;
    completedStepIds: string[];
    failedStepIds: string[];
    pendingStepIds: string[];
  };
  /** Human-readable position: the phase plus the step the model was on. */
  currentStep: string;
  phase: RunPhase;
  /**
   * The conversation, compacted to what a resumed run actually needs: the
   * goal, the plan, recent events, the current error, the current diff and
   * pending verification — not raw tool output or screenshots.
   */
  compactConversation: string;
  filesChanged: string[];
  fileChanges: CheckpointFileChange[];
  diffSummary: string;
  errors: CheckpointError[];
  verificationEvidence: CheckpointEvidence;
  tenantId?: string;
  organizationId?: string;
  /** The user the mission ran for — recovery rebuilds identity from this. */
  userId?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  sandboxId?: string | null;
  /** Execution identity: where it ran, on what provider, owned by whom. */
  execution?: {
    location?: string;
    provider?: string;
    sandboxId?: string | null;
    workerId?: string | null;
  };
  modelRoute?: { profile?: string; tier?: string; modelId?: string };
  /** Execution location the run was bound to (LOCAL / LOCAL_HOST / OVH_WORKER). */
  executionLocation?: string;
  /** Steering instructions already delivered, so they are never replayed twice. */
  steeringApplied?: string[];
  /** Stable ids of delivered steering — identical texts are still distinct. */
  steeringAppliedIds?: string[];
  /** Run event sequence at checkpoint time — resume consumes events after it. */
  sequence: number;
  timestamp: number;
}

interface EventLike { type: string; sequence?: number; data?: Record<string, any> }

const FILE_EVENT = /^(file\.created|file\.edit)$/;
const WRITE_TOOL = /^(write_file|edit_file|delete_file|move_file|apply_patch)$/i;

const STEP_STATUSES = new Set(["pending", "running", "completed", "failed", "skipped"]);

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

/** Whatever the caller's plan object is, reduce it to the checkpoint shape. */
function normalizePlan(plan: unknown): CheckpointPlan | null {
  if (!plan || typeof plan !== "object") return null;
  const p = plan as Record<string, unknown>;
  const steps: CheckpointPlanStep[] = (Array.isArray(p.steps) ? p.steps : []).flatMap((s, i) => {
    if (!s || typeof s !== "object") return [];
    const rec = s as Record<string, unknown>;
    const status = STEP_STATUSES.has(String(rec.status)) ? String(rec.status) as CheckpointPlanStep["status"] : "pending";
    return [{
      id: String(rec.id ?? `step-${i + 1}`),
      title: String(rec.title ?? rec.name ?? rec.id ?? `step-${i + 1}`),
      status,
      ...(Array.isArray(rec.dependsOn) ? { dependsOn: strList(rec.dependsOn) } : {}),
    }];
  });
  const hasStrategy =
    typeof p.objective === "string" ||
    Array.isArray(p.files_to_inspect) ||
    Array.isArray(p.verification_strategy);
  const strategy = hasStrategy
    ? {
        objective: typeof p.objective === "string" ? p.objective : undefined,
        filesToInspect: strList(p.files_to_inspect),
        likelyFilesToEdit: strList(p.likely_files_to_edit),
        verification: strList(p.verification_strategy),
        risks: strList(p.risks),
      }
    : undefined;
  if (!steps.length && !strategy) return null;
  return { ...(strategy ? { strategy } : {}), steps };
}

/**
 * Derive a checkpoint from the run's durable event log plus its live state.
 * `state` is intentionally `unknown`-shaped input so the module stays free of
 * the runtime's private RunState — the runtime maps the fields it owns.
 */
export function buildCheckpoint(input: {
  runId: string;
  objective: string;
  phase: RunPhase;
  events: EventLike[];
  plan?: unknown;
  state?: {
    workspaceId?: string | null;
    tenantId?: string;
    organizationId?: string;
    userId?: string;
    projectId?: string | null;
    sandboxId?: string | null;
    workerId?: string | null;
    executionProvider?: string;
    modelId?: string;
    route?: { profile?: string; tier?: string };
    executionLocation?: string;
    steeringApplied?: string[];
    currentStepId?: string;
    currentTaskId?: string;
    currentAction?: string;
  };
  /** A pre-compacted conversation summary, when the caller already made one. */
  compactConversation?: string;
}): MissionCheckpoint {
  const { events } = input;
  const fileOps = new Map<string, CheckpointFileChange>();
  const errors: CheckpointError[] = [];
  const steeringIds: string[] = [];
  const taskStatus = new Map<string, CheckpointPlanStep["status"]>();
  let lastTool = "";
  let lastChangeSeq = 0;
  for (const e of events) {
    const seq = Number(e.sequence ?? 0);
    if (e.type === "file.created" && typeof e.data?.path === "string") {
      fileOps.set(e.data.path, { path: e.data.path, operation: "create" });
      lastChangeSeq = Math.max(lastChangeSeq, seq);
    }
    if (e.type === "file.edit" && typeof e.data?.path === "string") {
      const op = e.data?.op === "delete" || e.data?.op === "move" ? e.data.op : "modify";
      fileOps.set(e.data.path, {
        path: e.data.path,
        operation: op,
        ...(op === "move" && typeof e.data?.to === "string" ? { destination: e.data.to } : {}),
      });
      lastChangeSeq = Math.max(lastChangeSeq, seq);
    }
    if ((e.type === "tool.completed" || e.type === "tool.failed") && WRITE_TOOL.test(String(e.data?.tool ?? ""))) {
      const p = String(e.data?.path ?? "");
      if (p && !fileOps.has(p)) fileOps.set(p, { path: p, operation: "modify" });
      lastChangeSeq = Math.max(lastChangeSeq, seq);
    }
    if (e.type === "tool.completed") {
      // A tool that later succeeds resolves earlier failures of the same
      // tool — resolved errors stay in history but aren't current defects.
      for (const err of errors) if (!err.resolved && err.tool === e.data?.tool) err.resolved = true;
    }
    if (e.type === "tool.failed") {
      errors.push({
        tool: String(e.data?.tool ?? "tool"),
        error: String(e.data?.error ?? "").slice(0, 300),
        errorClass: e.data?.errorClass ? String(e.data.errorClass) : undefined,
        at: seq,
      });
      lastTool = String(e.data?.tool ?? lastTool);
    }
    // Delivered steering ids: queue items carry a durable id; bare steers
    // get the event sequence — unique enough that identical texts stay distinct.
    if (e.type === "queue.item.delivered" || e.type === "steer.delivered") {
      steeringIds.push(String(e.data?.id ?? `seq-${seq}`));
    }
    if (e.type === "task.completed" && e.data?.taskId) {
      const s = String(e.data?.status ?? "completed");
      taskStatus.set(String(e.data.taskId), STEP_STATUSES.has(s) ? s as CheckpointPlanStep["status"] : "completed");
    }
  }

  // Verification position and freshness.
  const verification = [...events].reverse().find((e) => e.type === "verification.completed");
  const checks: Record<string, string> = {};
  for (const c of (verification?.data?.checks as { name: string; status: string }[] | undefined) ?? []) checks[c.name] = c.status;
  const preview = [...events].reverse().find((e) => e.type === "preview.available" || e.type === "preview.verified");
  const previewVerified = events.some((e) => e.type === "preview.verified");
  const previewRevision = events.filter((e) => e.type.startsWith("preview.")).length || undefined;

  const plan = normalizePlan(input.plan);
  // plan.created steps are titled strings; task.* events give them status.
  if (plan && !plan.steps.length) {
    const created = [...events].reverse().find((e) => e.type === "plan.created");
    const titles = strList(created?.data?.steps);
    plan.steps = titles.map((t, i) => {
      const id = `step-${i + 1}`;
      return { id, title: t, status: taskStatus.get(id) ?? "pending" };
    });
  }
  if (plan) {
    for (const step of plan.steps) {
      const st = taskStatus.get(step.id);
      if (st) step.status = st;
    }
  }
  const steps = plan?.steps ?? [];
  const running = steps.find((s) => s.status === "running") ?? steps.find((s) => s.status === "pending");

  const fileChanges = [...fileOps.values()];
  const summary = input.compactConversation ?? summarizeEvents(input.objective, events);

  return {
    runId: input.runId,
    objective: input.objective,
    plan,
    progress: {
      currentStepId: input.state?.currentStepId ?? running?.id,
      currentTaskId: input.state?.currentTaskId,
      currentAction: input.state?.currentAction,
      completedStepIds: steps.filter((s) => s.status === "completed").map((s) => s.id),
      failedStepIds: steps.filter((s) => s.status === "failed").map((s) => s.id),
      pendingStepIds: steps.filter((s) => s.status === "pending" || s.status === "running").map((s) => s.id),
    },
    currentStep: input.phase + (lastTool ? `: last failing tool ${lastTool}` : ""),
    phase: input.phase,
    compactConversation: summary,
    filesChanged: fileChanges.map((f) => f.path),
    fileChanges,
    diffSummary: fileChanges.length
      ? fileChanges.slice(0, 40).map((f) => `${f.path} ${f.operation}${f.destination ? ` → ${f.destination}` : ""}`).join("\n")
      : "no file changes recorded",
    errors: errors.slice(-20),
    verificationEvidence: {
      verifierVerdict: verification?.data?.verdict ? String(verification.data.verdict) : undefined,
      checks,
      previewUrl: preview?.data?.url ? String(preview.data.url) : undefined,
      ...(preview?.data?.url
        ? {
            preview: {
              url: String(preview.data.url),
              revision: previewRevision,
              status: (previewVerified ? "verified" : "active") as "verified" | "active",
            },
          }
        : {}),
      verificationSequence: verification ? Number(verification.sequence ?? 0) : undefined,
      lastChangeSequence: lastChangeSeq || undefined,
    },
    tenantId: input.state?.tenantId,
    organizationId: input.state?.organizationId,
    userId: input.state?.userId,
    projectId: input.state?.projectId ?? null,
    workspaceId: input.state?.workspaceId ?? null,
    sandboxId: input.state?.sandboxId ?? null,
    execution: {
      location: input.state?.executionLocation,
      provider: input.state?.executionProvider,
      sandboxId: input.state?.sandboxId ?? null,
      workerId: input.state?.workerId ?? null,
    },
    modelRoute: input.state?.modelId ? { ...input.state.route, modelId: input.state.modelId } : input.state?.route ? { ...input.state.route } : undefined,
    executionLocation: input.state?.executionLocation,
    steeringApplied: input.state?.steeringApplied ?? [],
    steeringAppliedIds: steeringIds,
    sequence: events.reduce((m, e) => Math.max(m, Number(e.sequence ?? 0)), 0),
    timestamp: Date.now(),
  };
}

/**
 * The compact conversation carried in a checkpoint: objective, what the run
 * did (counts, not transcripts), and where it stands. Kept short on purpose —
 * a resumed run re-reads files rather than trusting stale content.
 */
export function summarizeEvents(objective: string, events: EventLike[]): string {
  const lines: string[] = [`Objective: ${objective}`];
  const counts = new Map<string, number>();
  const notes: string[] = [];
  const outstanding: string[] = [];
  let lastChangeSeq = 0;
  let lastVerifySeq = -1;
  for (const e of events) {
    const seq = Number(e.sequence ?? 0);
    if (e.type === "tool.completed" || e.type === "tool.failed") {
      const key = `${e.data?.tool ?? "tool"}:${e.type === "tool.failed" ? "failed" : "ok"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (e.type === "file.created" || e.type === "file.edit") lastChangeSeq = Math.max(lastChangeSeq, seq);
    if (e.type === "verification.completed") lastVerifySeq = seq;
    if (e.type === "steer.delivered" && e.data?.text) notes.push(`User steering: ${String(e.data.text).slice(0, 200)}`);
    if (e.type === "verification.completed" && e.data?.verdict) {
      notes.push(`Verification: ${e.data.verdict}`);
      // Findings are what the resumed run still owes — surface them, not counts.
      for (const f of (e.data?.findings as { severity?: string; message?: string }[] | undefined) ?? []) {
        if (f.severity === "fail" || f.severity === "error") outstanding.push(`${f.severity}: ${String(f.message ?? "").slice(0, 160)}`);
      }
    }
    if (e.type === "mission.result.rejected" && Array.isArray(e.data?.incomplete)) {
      for (const id of e.data.incomplete) outstanding.push(`settlement rejected: ${String(id)}`);
    }
    if (e.type === "preview.available" && e.data?.url) notes.push(`Preview: ${e.data.url}`);
  }
  if (lastVerifySeq >= 0 && lastChangeSeq > lastVerifySeq) {
    outstanding.unshift("verification is stale — files changed after the last check");
  }
  if (counts.size) lines.push(`Work so far: ${[...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  for (const n of notes.slice(-6)) lines.push(n);
  if (outstanding.length) {
    lines.push("Outstanding:");
    for (const o of outstanding.slice(-6)) lines.push(`- ${o}`);
  }
  return lines.join("\n");
}

/** The user-facing prompt a resumed run is seeded with. */
export function resumePrompt(cp: MissionCheckpoint): string {
  const pending = cp.progress.pendingStepIds.length
    ? `Remaining steps: ${cp.progress.pendingStepIds.join(", ")}.`
    : "";
  const activeErrors = cp.errors.filter((e) => !e.resolved);
  return [
    "[Runtime recovery] This mission was interrupted (backend restart or worker loss) and is resuming from its durable checkpoint.",
    `Objective: ${cp.objective}`,
    `Phase when interrupted: ${cp.phase}. Files already changed: ${cp.filesChanged.length ? cp.filesChanged.join(", ") : "none recorded"}.`,
    pending,
    cp.verificationEvidence.verifierVerdict ? `Last verification: ${cp.verificationEvidence.verifierVerdict}.` : "",
    activeErrors.length ? `Unresolved errors: ${activeErrors.slice(-3).map((e) => `${e.tool}: ${e.error}`).join(" | ")}` : "",
    "Continue the SAME mission. Inspect the current files and git diff before changing anything — do not repeat completed work — then re-run required verification before calling report_result.",
  ].filter(Boolean).join("\n");
}
