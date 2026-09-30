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

export interface CheckpointError {
  tool: string;
  error: string;
  /** The typed error class from toolErrors.ts (fixable/retryable/…/fatal). */
  errorClass?: string;
  at: number;
}

export interface CheckpointEvidence {
  /** The independent verifier's latest verdict, when it ran. */
  verifierVerdict?: string;
  /** check name → pass/fail/skip/unverified */
  checks: Record<string, string>;
  /** Canonical preview URL this mission verified against, when one exists. */
  previewUrl?: string;
}

export interface MissionCheckpoint {
  runId: string;
  objective: string;
  /** The mission's structured plan (steps with status), when one exists. */
  plan: unknown;
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
  diffSummary: string;
  errors: CheckpointError[];
  verificationEvidence: CheckpointEvidence;
  tenantId?: string;
  organizationId?: string;
  projectId?: string | null;
  workspaceId?: string | null;
  sandboxId?: string | null;
  modelRoute?: { profile?: string; tier?: string; modelId?: string };
  /** Execution location the run was bound to (LOCAL / LOCAL_HOST / OVH_WORKER). */
  executionLocation?: string;
  /** Steering instructions already delivered, so they are never replayed twice. */
  steeringApplied?: string[];
  /** Run event sequence at checkpoint time — resume consumes events after it. */
  sequence: number;
  timestamp: number;
}

interface EventLike { type: string; sequence?: number; data?: Record<string, any> }

const FILE_EVENT = /^(file\.created|file\.edit)$/;
const WRITE_TOOL = /^(write_file|edit_file|delete_file|move_file|apply_patch)$/i;

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
    projectId?: string | null;
    sandboxId?: string | null;
    modelId?: string;
    route?: { profile?: string; tier?: string };
    executionLocation?: string;
    steeringApplied?: string[];
  };
  /** A pre-compacted conversation summary, when the caller already made one. */
  compactConversation?: string;
}): MissionCheckpoint {
  const { events } = input;
  const filesChanged = new Set<string>();
  const errors: CheckpointError[] = [];
  let lastTool = "";
  for (const e of events) {
    if (FILE_EVENT.test(e.type) && typeof e.data?.path === "string") filesChanged.add(e.data.path);
    if ((e.type === "tool.completed" || e.type === "tool.failed") && WRITE_TOOL.test(String(e.data?.tool ?? ""))) {
      const p = String(e.data?.path ?? "");
      if (p) filesChanged.add(p);
    }
    if (e.type === "tool.failed") {
      errors.push({
        tool: String(e.data?.tool ?? "tool"),
        error: String(e.data?.error ?? "").slice(0, 300),
        errorClass: e.data?.errorClass ? String(e.data.errorClass) : undefined,
        at: Number(e.sequence ?? 0),
      });
      lastTool = String(e.data?.tool ?? lastTool);
    }
  }

  const verification = [...events].reverse().find((e) => e.type === "verification.completed");
  const checks: Record<string, string> = {};
  for (const c of (verification?.data?.checks as { name: string; status: string }[] | undefined) ?? []) checks[c.name] = c.status;
  const preview = [...events].reverse().find((e) => e.type === "preview.available" || e.type === "preview.verified");

  const summary = input.compactConversation ?? summarizeEvents(input.objective, events);

  return {
    runId: input.runId,
    objective: input.objective,
    plan: input.plan ?? null,
    currentStep: input.phase + (lastTool ? `: last failing tool ${lastTool}` : ""),
    phase: input.phase,
    compactConversation: summary,
    filesChanged: [...filesChanged],
    diffSummary: `${filesChanged.size} file(s) changed`,
    errors: errors.slice(-20),
    verificationEvidence: {
      verifierVerdict: verification?.data?.verdict ? String(verification.data.verdict) : undefined,
      checks,
      previewUrl: preview?.data?.url ? String(preview.data.url) : undefined,
    },
    tenantId: input.state?.tenantId,
    organizationId: input.state?.organizationId,
    projectId: input.state?.projectId ?? null,
    workspaceId: input.state?.workspaceId ?? null,
    sandboxId: input.state?.sandboxId ?? null,
    modelRoute: input.state?.modelId ? { ...input.state.route, modelId: input.state.modelId } : input.state?.route ? { ...input.state.route } : undefined,
    executionLocation: input.state?.executionLocation,
    steeringApplied: input.state?.steeringApplied ?? [],
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
  for (const e of events) {
    if (e.type === "tool.completed" || e.type === "tool.failed") {
      const key = `${e.data?.tool ?? "tool"}:${e.type === "tool.failed" ? "failed" : "ok"}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (e.type === "steer.delivered" && e.data?.text) notes.push(`User steering: ${String(e.data.text).slice(0, 200)}`);
    if (e.type === "verification.completed" && e.data?.verdict) notes.push(`Verification: ${e.data.verdict}`);
    if (e.type === "preview.available" && e.data?.url) notes.push(`Preview: ${e.data.url}`);
  }
  if (counts.size) lines.push(`Work so far: ${[...counts.entries()].map(([k, n]) => `${k} ×${n}`).join(", ")}`);
  for (const n of notes.slice(-6)) lines.push(n);
  return lines.join("\n");
}

/** The user-facing prompt a resumed run is seeded with. */
export function resumePrompt(cp: MissionCheckpoint): string {
  return [
    "[Runtime recovery] This mission was interrupted (backend restart or worker loss) and is resuming from its durable checkpoint.",
    `Objective: ${cp.objective}`,
    `Phase when interrupted: ${cp.phase}. Files already changed: ${cp.filesChanged.length ? cp.filesChanged.join(", ") : "none recorded"}.`,
    cp.verificationEvidence.verifierVerdict ? `Last verification: ${cp.verificationEvidence.verifierVerdict}.` : "",
    cp.errors.length ? `Recent errors: ${cp.errors.slice(-3).map((e) => `${e.tool}: ${e.error}`).join(" | ")}` : "",
    "Continue the SAME mission. Inspect the current files and git diff before changing anything — do not repeat completed work — then re-run required verification before calling report_result.",
  ].filter(Boolean).join("\n");
}
