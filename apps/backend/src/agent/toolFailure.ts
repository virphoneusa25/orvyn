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
  "EXECUTION_FAILED",
  "TIMEOUT",
  "TRANSIENT_PROVIDER_ERROR",
  "UNKNOWN",
] as const;

export type ToolErrorType = (typeof TOOL_ERROR_TYPES)[number];

/** Same tool and the same invalid arguments, this many times, then stop. */
export const MALFORMED_CALL_LIMIT = 3;

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
