// Classifies a failed tool call so the runtime can tell a correctable
// schema mistake from a real execution failure. Schema mistakes go back to
// the same model with the missing fields. They do not climb the model ladder.

import { existsSync, readdirSync } from "fs";
import { resolveSafePath } from "../execution/pathSafety";
import type { ToolParameterSchema } from "./toolPolicy";
import { requiredArgumentNames } from "./toolPolicy";

export const TOOL_ERROR_TYPES = [
  "INVALID_ARGUMENTS",
  "PERMISSION_DENIED",
  "CAPABILITY_UNAVAILABLE",
  "RESOURCE_MISSING",
  "WRITE_GUARD",
  "EXECUTION_FAILED",
  "TIMEOUT",
  "TRANSIENT_PROVIDER_ERROR",
  "UNKNOWN",
] as const;

export type ToolErrorType = (typeof TOOL_ERROR_TYPES)[number];

/**
 * Same tool and the same invalid arguments, this many times, then that call is
 * blocked: the first is answered with a repair request; an identical repeat
 * means the repair did not happen, so it is not sent again.
 */
export const MALFORMED_CALL_LIMIT = 2;

/** Plain words for the user; the schema detail stays in diagnostics. */
export function friendlyArgumentFailure(tool: string, path?: string): string {
  const target = path ? path.split("/").pop() : "";
  const what = /\.css$/i.test(target ?? "") ? "stylesheet change" : /\.html?$/i.test(target ?? "") ? "page change" : target ? `change to ${target}` : "file change";
  if (/^(write_file|edit_file|apply_edit|delete_file|move_file)$/.test(tool)) return `ORION couldn't apply the ${what} because the file-edit request was malformed.`;
  return `ORION's ${tool} request was malformed.`;
}

/**
 * The model's tool call arrived unreadable (cut off at the output limit, or
 * not JSON). Nothing runs; the model gets one compact repair request.
 */
export function unreadableArgumentsPayload(input: {
  tool: string;
  reason: "truncated" | "invalid_json";
  rawLength: number;
  keys: string[];
  path?: string;
  schema?: ToolParameterSchema;
  blocked?: boolean;
}): { error: string; diagnostic: string; modelText: string } {
  const required = requiredArgumentNames(input.tool, input.schema);
  const diagnostic = `${input.tool}: arguments ${input.reason === "truncated" ? "cut off" : "not valid JSON"} after ${input.rawLength} characters (received keys: ${input.keys.join(", ") || "none"}).`;
  const writeTool = input.tool === "write_file";
  const guidance = input.blocked
    ? `This exact ${input.tool} call is blocked. Take a different approach for this step.`
    : input.reason === "truncated"
      ? writeTool
        ? `Your ${input.tool} call was cut off after ${input.rawLength} characters because your reply reached the output limit, so nothing was written. Do not resend the whole file in one call. Write it in parts: write_file {"path": "${input.path ?? "<file>"}", "content": "<first part, about 150 lines>"}, then write_file {"path": "${input.path ?? "<file>"}", "content": "<next part>", "append": true} for each next part. For an existing file, prefer edit_file with a small old_string/new_string.`
        : `Your ${input.tool} call was cut off after ${input.rawLength} characters (the reply reached the output limit). Send it again with smaller arguments.`
      : `Your ${input.tool} arguments were not valid JSON. Send them again as one JSON object with ${required.join(", ")}.`;
  return {
    error: friendlyArgumentFailure(input.tool, input.path),
    diagnostic,
    modelText: JSON.stringify({
      ok: false,
      code: "INVALID_TOOL_ARGUMENTS",
      errorType: "INVALID_ARGUMENTS",
      tool: input.tool,
      reason: input.reason,
      receivedKeys: input.keys,
      expected: { required, properties: propertyTypes(input.tool, input.schema) },
      retryable: !input.blocked,
      guidance,
    }),
  };
}

const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "coverage", ".orvyn"]);

export function normalizeErrorType(value: unknown): ToolErrorType {
  return TOOL_ERROR_TYPES.includes(value as ToolErrorType) ? (value as ToolErrorType) : "UNKNOWN";
}

/** INVALID_ARGUMENTS is correctable on the current model. Every other class can climb. */
export function countsTowardModelEscalation(errorType: ToolErrorType): boolean {
  return errorType !== "INVALID_ARGUMENTS";
}

function quoted(names: string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function propertyTypes(name: string, schema?: ToolParameterSchema): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const [key, value] of Object.entries(schema?.properties ?? {})) {
    properties[key] = value?.type || "string";
  }
  for (const field of requiredArgumentNames(name, schema)) {
    if (!properties[field]) properties[field] = "string";
  }
  return properties;
}

export function invalidArgumentsPayload(input: {
  tool: string;
  missing: string[];
  invalid: string[];
  schema?: ToolParameterSchema;
  blocked?: boolean;
}): { error: string; modelText: string; retryable: boolean } {
  const required = requiredArgumentNames(input.tool, input.schema);
  const blocked = Boolean(input.blocked);
  const missingText = input.missing.length ? `missing: ${input.missing.join(", ")}` : "";
  const invalidText = input.invalid.length ? `invalid: ${input.invalid.join(", ")}` : "";
  const which = [missingText, invalidText].filter(Boolean).join("; ");
  const error = blocked
    ? `Blocked: ${input.tool} repeated the same invalid arguments ${MALFORMED_CALL_LIMIT} times${which ? ` (${which})` : ""}. This run will not repeat that call.`
    : [
        input.missing.length ? `${input.tool} is missing required argument${input.missing.length === 1 ? "" : "s"} ${quoted(input.missing)}.` : "",
        input.invalid.length ? `${input.tool} has invalid argument${input.invalid.length === 1 ? "" : "s"} ${quoted(input.invalid)}.` : "",
      ].filter(Boolean).join(" ");
  const guidance = blocked
    ? error
    : `Call ${input.tool} again in this same run with ${required.join(", ") || "valid arguments"}. Supply every missing field. Do not switch models to avoid the arguments.`;
  const body: Record<string, unknown> = {
    ok: false,
    code: "INVALID_TOOL_ARGUMENTS",
    tool: input.tool,
    errorType: "INVALID_ARGUMENTS",
    missing: input.missing,
    retryable: !blocked,
    schema: { required, properties: propertyTypes(input.tool, input.schema) },
    guidance,
  };
  if (input.invalid.length) body.invalid = input.invalid;
  if (blocked) body.blocked = true;
  return { error, modelText: JSON.stringify(body), retryable: !blocked };
}

export function permissionDeniedPayload(tool: string): { error: string; modelText: string } {
  const message = `Tool "${tool}" is denied by project permissions. Try another approach.`;
  return {
    error: "Denied by project permissions",
    modelText: JSON.stringify({
      ok: false,
      errorType: "PERMISSION_DENIED",
      retryable: false,
      message,
      guidance: "This is a permission denial, not an argument error. Do not correct it by adding path or content and retrying the same tool.",
    }),
  };
}

const RESOURCE_MISSING_RE = /\b(ENOENT|ENOTDIR)\b|no such file or directory/i;
const PERMISSION_RE = /\b(EACCES|EPERM)\b|permission denied|escapes the project root|outside the project root|escapes the workspace|outside the workspace/i;
const TIMEOUT_RE = /\b(timed? ?out|ETIMEDOUT|deadline exceeded)\b/i;
const TRANSIENT_RE = /\b(ECONNRESET|ECONNREFUSED|EAI_AGAIN|EBUSY|socket hang up|rate limit|temporarily unavailable)\b|\b(502|503|504)\b/i;

/** A tool that already passed argument checks and then failed while running. */
export function classifyExecutedToolFailure(error: string): ToolErrorType {
  const text = String(error ?? "");
  // Write-safety interception (not a crash): the guard steered the agent to a
  // targeted edit or a read-first. Rendered as a warning, never a fatal ✕.
  if (/\b(DESTRUCTIVE_REWRITE|READ_FIRST_BEFORE_REWRITE|AUTHORIZED_REWRITE)\b/.test(text)) return "WRITE_GUARD";
  // The execution sandbox refused the action. A policy decision, never a
  // model or provider failure: nothing here may trigger a model switch.
  if (/\b(NETWORK_POLICY_DENIED|CREDENTIAL_POLICY_DENIED)\b/.test(text)) return "PERMISSION_DENIED";
  if (/\bSANDBOX_UNAVAILABLE\b/.test(text)) return "CAPABILITY_UNAVAILABLE";
  if (RESOURCE_MISSING_RE.test(text) && !/old_string not found/i.test(text)) return "RESOURCE_MISSING";
  if (PERMISSION_RE.test(text)) return "PERMISSION_DENIED";
  if (TIMEOUT_RE.test(text)) return "TIMEOUT";
  if (TRANSIENT_RE.test(text)) return "TRANSIENT_PROVIDER_ERROR";
  if (!text.trim()) return "UNKNOWN";
  return "EXECUTION_FAILED";
}

export interface WorkspaceSnapshot {
  root: string;
  exists: boolean;
  entries: string[];
  requestedPath?: string;
  requestedExists: boolean;
}

/** What is actually in the workspace, so the model does not invent a new path. */
export function workspaceSnapshot(root: string, requestedPath?: string): WorkspaceSnapshot {
  const entries: string[] = [];
  let exists = false;
  try {
    exists = existsSync(root);
    if (exists) {
      for (const name of readdirSync(root)) {
        if (!name || name.startsWith(".") || SKIP_DIR.has(name)) continue;
        entries.push(name);
        if (entries.length >= 40) break;
      }
    }
  } catch {
    exists = false;
  }
  entries.sort();
  let requestedExists = false;
  const requested = String(requestedPath ?? "").trim();
  if (requested && exists) {
    try {
      requestedExists = existsSync(resolveSafePath(root, requested));
    } catch {
      requestedExists = false;
    }
  }
  return {
    root,
    exists,
    entries,
    ...(requested ? { requestedPath: requested } : {}),
    requestedExists,
  };
}

export function executedFailurePayload(input: {
  tool: string;
  error: string;
  errorType: ToolErrorType;
  workspace?: WorkspaceSnapshot;
}): string {
  if (input.errorType === "RESOURCE_MISSING") {
    const workspace = input.workspace;
    return JSON.stringify({
      ok: false,
      errorType: "RESOURCE_MISSING",
      retryable: false,
      path: workspace?.requestedPath,
      message: input.error,
      workspace: {
        root: workspace?.root,
        exists: workspace?.exists ?? false,
        entries: workspace?.entries ?? [],
        requestedExists: workspace?.requestedExists ?? false,
      },
      guidance: "This path is not in the workspace. The entries listed are what exists at the workspace root. Use one of those paths, or a file under this root. Do not invent an unrelated path.",
    });
  }
  const retryable = input.errorType === "TIMEOUT" || input.errorType === "TRANSIENT_PROVIDER_ERROR";
  const guidance = input.errorType === "EXECUTION_FAILED"
    ? "The call ran with valid arguments and failed. Diagnose and try a different approach. Do not repeat the identical call."
    : input.errorType === "TIMEOUT"
      ? "The call timed out. Retry only if the same arguments are still the right ones."
      : input.errorType === "TRANSIENT_PROVIDER_ERROR"
        ? "The failure looks transient. The same call may succeed if tried again."
        : input.errorType === "PERMISSION_DENIED"
          ? "The call was refused. This is not an argument error."
          : "The call failed.";
  return JSON.stringify({
    ok: false,
    errorType: input.errorType,
    retryable,
    message: input.error,
    guidance,
  });
}
