// apps/backend/src/agent/resultContract.ts
//
// The terminal result contract. A model response ending is NEVER a mission
// ending: a run may only finish through an explicit runtime-level completion
// request, and only the settlement step may mark it completed.
//
//   agent calls report_result { status, summary, evidence }
//        ↓
//   settlement evaluates the run's required criteria
//        ↓
//   completed requested but criteria unmet
//        ↓
//   CompletionRejected → back to the agent as a tool result → work continues
//
// The invariant this enforces:
//
//   run.status === "completed"  ONLY IF  every required objective passed
//                                        AND every required verification passed
//
// "Not fully done yet" + "Completed" is an impossible state by construction:
// the same function that accepts the request is the only writer of the
// terminal status.

import type { RunStatus } from "./events";

export const REPORT_RESULT_TOOL = "report_result";

/**
 * The LLM-facing definition of the terminal result tool. The runtime
 * intercepts it — it never reaches ToolGateway or an execution provider.
 */
export function reportResultToolDefinition(): { name: string; description: string; parameters: Record<string, unknown> } {
  return {
    name: REPORT_RESULT_TOOL,
    description:
      "Report this mission's terminal result. Call exactly once, when the work is done or cannot proceed further — a plain text reply does NOT end the mission. " +
      "status 'completed' only when every required verification genuinely passed (the runtime checks the evidence and REJECTS premature completion); " +
      "'partial' when real progress exists but something required is unverifiable or unfinished; " +
      "'blocked' when the mission is waiting on the user, a permission, or a missing capability; " +
      "'failed' when the objective cannot be met. After calling it, write the final user-facing summary and stop calling tools.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["completed", "partial", "blocked", "failed"],
          description: "The terminal status the evidence supports.",
        },
        summary: {
          type: "string",
          description: "One short paragraph for the user: what changed and what was verified.",
        },
        evidence: {
          type: "array",
          items: { type: "string" },
          description: "Proof pointers: artifact ids, test commands run, preview URL, screenshot names.",
        },
      },
      required: ["status", "summary"],
      additionalProperties: false,
    },
  };
}

const RESULT_STATUSES = new Set(["completed", "partial", "blocked", "failed"]);

/** Validate a report_result call. Bad arguments are a fixable error, not a rejection. */
export function parseResultRequest(args: unknown):
  | { ok: true; request: MissionResultRequest }
  | { ok: false; error: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const status = String(a.status ?? "").trim();
  const summary = String(a.summary ?? "").trim();
  if (!RESULT_STATUSES.has(status)) {
    return { ok: false, error: `status must be one of completed|partial|blocked|failed (got "${status || "missing"}")` };
  }
  if (!summary) return { ok: false, error: "summary is required — one short paragraph of what changed and what was verified" };
  const evidence = Array.isArray(a.evidence) ? a.evidence.filter((e): e is string => typeof e === "string").slice(0, 20) : undefined;
  return { ok: true, request: { status: status as MissionResultRequest["status"], summary: summary.slice(0, 2000), evidence } };
}

/** Terminal statuses a run may settle into. "Complete" is a status, never a workflow phase. */
export type TerminalResult = "completed" | "partial" | "blocked" | "failed" | "cancelled";

/** What the agent asks the runtime for when it believes work is done. */
export interface MissionResultRequest {
  status: "completed" | "partial" | "blocked" | "failed";
  /** One short paragraph for the user: what changed and what was verified. */
  summary: string;
  /** Pointers to proof: artifactIds, test runs, preview URLs, screenshots. */
  evidence?: string[];
}

/**
 * One required (or informational) criterion of this mission. Derived from the
 * task and the run's own events — the model cannot assert them away.
 */
export interface SettlementCriterion {
  id: string;
  /** A required criterion that did not pass blocks a "completed" result. */
  required: boolean;
  status: "pass" | "fail" | "unverified" | "not_run";
  detail?: string;
}

export interface SettlementInput {
  request: MissionResultRequest;
  criteria: SettlementCriterion[];
}

export type SettlementVerdict =
  | {
      accepted: true;
      /** The settled terminal status — may differ from what was asked for. */
      status: Exclude<TerminalResult, "cancelled">;
      summary: string;
      /** The full criteria matrix, for admin diagnostics and the audit trail. */
      criteria: SettlementCriterion[];
    }
  | {
      accepted: false;
      error: "CompletionRejected";
      /** The required criteria that still stand between the run and completion. */
      incomplete: SettlementCriterion[];
      /** Structured payload delivered back to the agent as the tool result. */
      modelText: string;
      criteria: SettlementCriterion[];
    };

const CANCELABLE: TerminalResult[] = ["completed", "partial", "blocked", "failed"];

/**
 * Judge a completion request against the evidence. Pure and deterministic —
 * the same criteria always settle the same way, so the rule can be tested
 * without a model in the loop.
 */
export function settleResult(input: SettlementInput): SettlementVerdict {
  const { request, criteria } = input;
  const unmet = criteria.filter((c) => c.required && c.status !== "pass");

  if (request.status === "completed") {
    if (unmet.length > 0) {
      const lines = unmet.map((c) => `- ${c.id}: ${c.status}${c.detail ? ` — ${c.detail}` : ""}`);
      return {
        accepted: false,
        error: "CompletionRejected",
        incomplete: unmet,
        criteria,
        modelText: JSON.stringify({
          ok: false,
          error: "CompletionRejected",
          message: "Required verification criteria remain incomplete.",
          incomplete: unmet.map((c) => ({ id: c.id, status: c.status, detail: c.detail ?? null })),
          guidance: [
            "Continue working. Do not restate that the task is done.",
            "Fix or genuinely verify each item listed, then call report_result again.",
            "If an item cannot be satisfied in this environment (e.g. no browser), report partial instead of completed and name it in the summary.",
          ].join(" "),
        }),
      };
    }
    return { accepted: true, status: "completed", summary: request.summary, criteria };
  }

  // partial / blocked / failed are honest asks: settle as requested, but keep
  // the criteria record so the run's history shows exactly what was unmet.
  const status: Exclude<TerminalResult, "cancelled"> = CANCELABLE.includes(request.status) ? request.status : "partial";
  return { accepted: true, status, summary: request.summary, criteria };
}

// ── Criteria derivation ──────────────────────────────────────────────────────

interface EventLike { type: string; data?: Record<string, any> }

function latest(events: EventLike[], type: string): EventLike | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return undefined;
}

const TEST_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|vitest|jest|mocha|pytest|go\s+test|cargo\s+test|tsc\b|typecheck|lint)\b/i;

/** Does the instruction ask for a mobile/responsive check? Required only then. */
export const NEEDS_MOBILE = /\b(mobile|responsive|phone|small screen|narrow viewport)\b/i;

/**
 * Build the criteria matrix a settlement decision is judged against, from the
 * run's own event log. Required criteria are derived from what the task asked
 * for — never from what the model claims it did.
 */
export function settlementCriteria(input: {
  instruction: string;
  events: EventLike[];
  /** The task required a file deliverable in Files → Generated. */
  needsArtifact: boolean;
  /** The task was a workspace file write/edit. */
  needsWorkspaceWrite: boolean;
  /** The task asked for tests/a typecheck/a lint. */
  needsTests: boolean;
  /** A website/page task: files + a live preview + a browser check. */
  website: boolean;
  /** Visual proof was required (screenshot / desktop verification). */
  needsVisual: boolean;
  /** The independent verifier ran; its verdict (null = never ran). */
  verifierVerdict?: "PASS" | "FAIL" | "PARTIAL" | null;
  /**
   * The verify loop already accepted a PARTIAL verdict — no blocker findings,
   * and either only verifier-side gaps remained or the finding survived its
   * repair round (environmental gaps like no git/no browser cannot be fixed
   * by the agent). Mirrors the retry policy; a FAIL or a blocker is never
   * accepted.
   */
  verifierAccepted?: boolean;
  /** True when implementation happened (files changed) — the verifier is then required. */
  implementationWork: boolean;
}): SettlementCriterion[] {
  const { events } = input;
  const out: SettlementCriterion[] = [];

  const criterion = (id: string, required: boolean, status: SettlementCriterion["status"], detail?: string) =>
    out.push({ id, required, status, ...(detail ? { detail } : {}) });

  if (input.needsWorkspaceWrite) {
    const wrote = events.some((e) =>
      e.type === "file.created" || e.type === "file.edit" ||
      (e.type === "tool.completed" && /^(write_file|edit_file)$/i.test(String(e.data?.tool ?? ""))));
    criterion("workspace_files", true, wrote ? "pass" : "not_run", wrote ? undefined : "no workspace write succeeded");
  }

  if (input.needsArtifact) {
    const ready = events.some((e) => e.type === "artifact.created" && e.data?.artifactId);
    criterion("artifact", true, ready ? "pass" : "not_run", ready ? undefined : "no persisted artifactId");
  }

  if (input.needsTests) {
    // tool.* events carry callId, not the command — join with tool.input first.
    const commands = new Map<string, string>();
    for (const e of events) {
      if (e.type === "tool.input" && typeof e.data?.input?.command === "string") commands.set(String(e.data.callId), e.data.input.command);
    }
    const isTestEvent = (e: EventLike) =>
      e.type === "test.completed" ||
      ((e.type === "tool.completed" || e.type === "tool.failed") &&
        (/test|typecheck|lint/i.test(String(e.data?.tool ?? "")) || TEST_CMD.test(commands.get(String(e.data?.callId ?? "")) ?? "")));
    const lastTest = [...events].reverse().find(isTestEvent);
    const lastFailed = lastTest && (lastTest.type === "tool.failed" || lastTest.data?.ok === false || lastTest.data?.passed === false);
    criterion("tests", true, !lastTest ? "not_run" : lastFailed ? "fail" : "pass",
      !lastTest ? "no test or build ran" : lastFailed ? "the last test/build run failed" : undefined);
  }

  if (input.website) {
    const preview = latest(events, "preview.verified") ?? latest(events, "preview.failed");
    criterion("preview", true,
      preview?.type === "preview.verified" ? "pass" : preview ? "fail" : "not_run",
      preview?.type === "preview.verified" ? undefined : (preview?.data?.issues as string[] | undefined)?.[0] ?? "the live preview was not verified");
    const consoleCheck = latest(events, "verification.completed");
    const browserCheck = (consoleCheck?.data?.checks as { name: string; status: string }[] | undefined)?.find((c) => /browser|console/i.test(c.name));
    criterion("console", true,
      browserCheck ? (browserCheck.status === "pass" ? "pass" : "fail") : "unverified",
      browserCheck?.status === "pass" ? undefined : "console/network errors on the page");
    criterion("browser_screenshot", false,
      events.some((e) => e.type === "desktop.screenshot" || (e.type === "tool.completed" && /screenshot/i.test(String(e.data?.tool ?? "")))) ? "pass" : "not_run");
  }

  if (NEEDS_MOBILE.test(input.instruction)) {
    const mobile = events.some((e) =>
      (e.type === "tool.completed" && /viewport|mobile/i.test(String(e.data?.tool ?? ""))) ||
      /mobile|narrow|375|390|414/.test(String(e.data?.note ?? e.data?.url ?? "")));
    criterion("mobile", true, mobile ? "pass" : "not_run", mobile ? undefined : "no mobile-viewport check ran");
  }

  if (input.needsVisual && !input.website) {
    const shot = events.some((e) =>
      e.type === "desktop.verification.passed" || e.type === "desktop.screenshot" || e.type === "browser.completed" ||
      (e.type === "tool.completed" && /screenshot|browser_screenshot|desktop_screenshot/i.test(String(e.data?.tool ?? ""))));
    criterion("visual", true, shot ? "pass" : "not_run", shot ? undefined : "no screenshot or desktop verification exists");
  }

  if (input.implementationWork) {
    const passed = input.verifierVerdict === "PASS" || input.verifierAccepted === true;
    criterion("verification", true,
      passed ? "pass"
        : input.verifierVerdict === "FAIL" ? "fail"
        : input.verifierVerdict ? "unverified"
        : "not_run",
      passed ? undefined : "the independent check did not pass");
  }

  return out;
}
