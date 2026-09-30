// apps/backend/src/agent/toolErrors.ts
//
// The typed tool error model. A tool failure is not one thing — recovery
// depends on WHAT failed:
//
//   ToolExecutionError
//     ├ FixableToolError             malformed arguments / schema mistakes
//     ├ RetryableToolError           timeouts, 429s, transient network
//     ├ PermissionToolError          the user/policy refused the action
//     ├ PolicyToolError              sandbox policy denied it (network, creds)
//     ├ WorkspaceToolError           workspace not mounted / path missing
//     ├ CapabilityUnavailableError   the capability does not exist here
//     └ FatalToolError               the tool itself crashed
//
// Only the class decides recovery — never a string match at the call site.
// None of these is a model or provider failure, so none of them may trigger
// a model switch. Model fallback exists for provider failure, model timeout,
// capability mismatch and quality escalation — nothing else.
//
// `ToolErrorType` (toolFailure.ts) stays the wire-level label events carry;
// this module is the semantic layer the runtime reasons with.

import type { ToolErrorType } from "./toolFailure";

export type ToolErrorClass =
  | "fixable"
  | "retryable"
  | "permission"
  | "policy"
  | "workspace"
  | "capability"
  | "fatal";

export class ToolExecutionError extends Error {
  readonly toolErrorClass: ToolErrorClass = "fatal";
  /** Stable machine code for diagnostics and tests. */
  readonly code: string = "TOOL_ERROR";
  /** The tool that produced the failure, when known. */
  readonly tool?: string;
  /** The underlying wire-level type, when one was already classified. */
  readonly errorType?: ToolErrorType;
  /** May the SAME call be tried again as-is? */
  readonly retryable: boolean = false;
  /** Tool errors are never a reason to change models. */
  readonly modelEscalation: false = false;

  constructor(message: string, opts: { tool?: string; errorType?: ToolErrorType; code?: string } = {}) {
    super(message);
    this.name = new.target.name;
    this.tool = opts.tool;
    this.errorType = opts.errorType;
    if (opts.code) this.code = opts.code;
  }
}

/** Bad arguments the model can correct on the next call (BAD_ARGS, unreadable JSON, schema mismatch). */
export class FixableToolError extends ToolExecutionError {
  readonly toolErrorClass = "fixable";
  readonly code = "BAD_ARGS";
  readonly missing?: string[];
  readonly invalid?: string[];
  constructor(message: string, opts: ConstructorParameters<typeof ToolExecutionError>[1] & { missing?: string[]; invalid?: string[] } = {}) {
    super(message, opts);
    this.missing = opts.missing;
    this.invalid = opts.invalid;
  }
}

/** A temporary failure — the same call may succeed later (timeout, 429, transient network). */
export class RetryableToolError extends ToolExecutionError {
  readonly toolErrorClass = "retryable";
  readonly code = "TEMPORARY_FAILURE";
  readonly retryable = true;
  /** Suggested wait before the retry. */
  readonly retryAfterMs: number;
  constructor(message: string, opts: ConstructorParameters<typeof ToolExecutionError>[1] & { retryAfterMs?: number } = {}) {
    super(message, opts);
    this.retryAfterMs = opts.retryAfterMs ?? 2_000;
  }
}

/** The user or a project permission refused the action. Do not retry — ask or choose another path. */
export class PermissionToolError extends ToolExecutionError {
  readonly toolErrorClass = "permission";
  readonly code = "PERMISSION_DENIED";
}

/** A sandbox/policy boundary refused the action (network policy, credential policy). Ask for a grant; never retry blindly. */
export class PolicyToolError extends ToolExecutionError {
  readonly toolErrorClass = "policy";
  readonly code = "POLICY_DENIED";
}

/** The workspace itself is the problem: not mounted, no repository, path outside the root, missing file. */
export class WorkspaceToolError extends ToolExecutionError {
  readonly toolErrorClass = "workspace";
  readonly code = "WORKSPACE_UNAVAILABLE";
}

/** The named capability does not exist in this run — select an equivalent one instead of retrying. */
export class CapabilityUnavailableError extends ToolExecutionError {
  readonly toolErrorClass = "capability";
  readonly code = "CAPABILITY_UNAVAILABLE";
  readonly query?: string;
  constructor(message: string, opts: ConstructorParameters<typeof ToolExecutionError>[1] & { query?: string } = {}) {
    super(message, opts);
    this.query = opts.query;
  }
}

/** The tool crashed internally. Stop this execution path — retrying cannot fix a broken tool. */
export class FatalToolError extends ToolExecutionError {
  readonly toolErrorClass = "fatal";
  readonly code = "TOOL_INTERNAL_ERROR";
}

// ── Classification ───────────────────────────────────────────────────────────

const RETRYABLE_CODES = /\b(429|rate.?limit|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EBUSY|socket hang up|timed? ?out|temporarily unavailable|502|503|504)\b/i;
const POLICY_CODES = /\b(NETWORK_POLICY_DENIED|CREDENTIAL_POLICY_DENIED|POLICY_DENIED|policy violation)\b/i;
const PERMISSION_CODES = /\b(EACCES|EPERM)\b|permission denied|denied by (?:project|capability) permissions|user denied|approval was not answered|escapes the project root|outside the (?:project root|workspace)|escapes the workspace/i;
const WORKSPACE_CODES = /\b(ENOENT|ENOTDIR|workspace not mounted|no such file or directory|not a directory|outside the mounted workspace|WORKSPACE_UNAVAILABLE)\b/i;
const CAPABILITY_CODES = /\b(CAPABILITY_UNAVAILABLE|SANDBOX_UNAVAILABLE|no tool named|unknown tool|not installed|not available in this (?:run|environment))\b/i;
const FATAL_CODES = /\b(TOOL_INTERNAL_ERROR|crashed|segmentation|panicked|heap|out of memory)\b/i;

/**
 * Map any tool failure — a ToolErrorType, a tool's error text, or a thrown
 * exception — onto the typed model. `errorType` wins when a caller already
 * classified the failure at the wire layer; the message is the fallback.
 */
export function classifyToolError(input: {
  tool?: string;
  error: unknown;
  errorType?: ToolErrorType;
  missing?: string[];
  invalid?: string[];
}): ToolExecutionError {
  const message = input.error instanceof Error ? input.error.message : String(input.error ?? "Tool execution failed");
  const opts = { tool: input.tool, errorType: input.errorType };

  switch (input.errorType) {
    case "INVALID_ARGUMENTS":
      return new FixableToolError(message, { ...opts, missing: input.missing, invalid: input.invalid });
    case "TIMEOUT":
      return new RetryableToolError(message, { ...opts, code: "TEMPORARY_TIMEOUT" });
    case "TRANSIENT_PROVIDER_ERROR":
      return new RetryableToolError(message, { ...opts, code: "TEMPORARY_FAILURE" });
    case "PERMISSION_DENIED":
      return POLICY_CODES.test(message) ? new PolicyToolError(message, opts) : new PermissionToolError(message, opts);
    case "WRITE_GUARD":
      return new PolicyToolError(message, { ...opts, code: "WRITE_GUARD" });
    case "RESOURCE_MISSING":
      return new WorkspaceToolError(message, { ...opts, code: "RESOURCE_MISSING" });
    case "CAPABILITY_UNAVAILABLE":
      return new CapabilityUnavailableError(message, opts);
    case "EXECUTION_FAILED":
      break; // fall through to message classification
    default:
      break;
  }

  if (POLICY_CODES.test(message)) return new PolicyToolError(message, opts);
  if (PERMISSION_CODES.test(message)) return new PermissionToolError(message, opts);
  if (WORKSPACE_CODES.test(message)) return new WorkspaceToolError(message, opts);
  if (CAPABILITY_CODES.test(message)) return new CapabilityUnavailableError(message, opts);
  if (RETRYABLE_CODES.test(message)) return new RetryableToolError(message, opts);
  if (FATAL_CODES.test(message)) return new FatalToolError(message, opts);
  // A tool that ran with valid arguments and failed for an unclassified
  // reason: the path ends here — the model must change approach, not retry.
  return new FatalToolError(message, { ...opts, code: "EXECUTION_FAILED" });
}

// ── Recovery policy ──────────────────────────────────────────────────────────

export type RecoveryAction =
  /** Hand the model the schema problem; it repairs the arguments once. */
  | { action: "repair_arguments"; guidance: string }
  /** The same call may succeed later. Bounded; the runtime enforces the cap. */
  | { action: "retry_backoff"; retryAfterMs: number; maxAttempts: number }
  /** Nothing to retry: the person must grant the action or the run picks a permitted path. */
  | { action: "request_permission"; guidance: string }
  /** Same need, different capability (e.g. MCP down → native tool; no native → shell workaround). */
  | { action: "select_alternative"; guidance: string }
  /** The workspace record is wrong or missing — re-resolve it before touching files again. */
  | { action: "resolve_workspace"; guidance: string }
  /** This execution path is dead. Do not retry it. */
  | { action: "stop_path"; guidance: string };

export function recoveryFor(error: ToolExecutionError): RecoveryAction {
  switch (error.toolErrorClass) {
    case "fixable":
      return {
        action: "repair_arguments",
        guidance: `Repair the ${error.tool ?? "tool"} arguments against its schema and call it once more. Do not switch models to avoid the arguments.`,
      };
    case "retryable": {
      const retry = error as RetryableToolError;
      return { action: "retry_backoff", retryAfterMs: retry.retryAfterMs, maxAttempts: 3 };
    }
    case "permission":
      return {
        action: "request_permission",
        guidance: "The action was refused. Do not retry it unchanged: ask the user for permission, or reach the goal through a permitted path.",
      };
    case "policy":
      return {
        action: "request_permission",
        guidance: "The execution sandbox refused this under its policy (network or credential). Request the access explicitly, or choose an action the policy allows.",
      };
    case "capability":
      return {
        action: "select_alternative",
        guidance: "This capability is not available in this run. Select an equivalent capability from the registry (native tool → installed skill → connected MCP → sandbox command). Do not invent tool names.",
      };
    case "workspace":
      return {
        action: "resolve_workspace",
        guidance: "The workspace path was wrong or unavailable. Re-check what actually exists (list the workspace root) before touching a file again; never invent a path.",
      };
    case "fatal":
      return {
        action: "stop_path",
        guidance: "This tool crashed internally. Do not retry the identical call — take a different approach for this step.",
      };
  }
}

/** Guidance text the model receives with a failed tool result. */
export function recoveryGuidance(error: ToolExecutionError): string {
  const action = recoveryFor(error);
  if (action.action === "retry_backoff") {
    return `This is a temporary failure, not a wrong call. Retry it after a short wait (about ${Math.round(action.retryAfterMs / 1000)}s, up to ${action.maxAttempts} attempts) — do not switch models or tools.`;
  }
  return action.guidance;
}
