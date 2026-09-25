// apps/backend/src/gateway/toolResultEnvelope.ts
//
// One shape for every tool result that leaves ToolGateway:
//
//   toolName        which tool ran
//   status          success | error | blocked | cancelled
//   modelPayload    the tool's answer to the model (the runtime clamps it for size)
//   userSummary     one line a person can read ("Wrote hello.txt · 12 bytes")
//   structuredData  metadata the app can rely on (path, bytes, sha256, exit code)
//   evidence        what the tool proves happened (file + operation, command + exit)
//   retryable       whether the same call could succeed if tried again
//
// The tools themselves are unchanged. The gateway wraps whatever ToolResult a
// tool returns. Evidence is built from the call's own arguments plus the
// result, never from the model's prose.
//
// Adapted from CoWork-OS (MIT), src/electron/agent/runtime/tool-result-envelope.ts.

import { createHash } from "crypto";
import * as path from "path";
import type { ToolResult } from "../ai/ToolTypes";

export type ToolResultEnvelopeStatus = "success" | "error" | "blocked" | "cancelled";

export type FileOperation = "read" | "write" | "edit" | "delete" | "move";

export interface ToolResultEvidence {
  type: "file" | "command" | "service" | "url" | "artifact" | "runtime_log";
  label: string;
  /** The main identifier: a workspace-relative file, a command, a URL. */
  value: string;
  /** For file evidence: what was done to `file`. */
  operation?: FileOperation | "run";
  file?: string;
  command?: string;
  extra?: Record<string, unknown>;
}

export interface ToolResultEnvelope {
  toolUseId?: string;
  toolName: string;
  status: ToolResultEnvelopeStatus;
  modelPayload: string;
  userSummary: string;
  structuredData: Record<string, unknown>;
  evidence: ToolResultEvidence[];
  retryable: boolean;
  durationMs?: number;
}

export interface BuildEnvelopeParams {
  toolName: string;
  args: Record<string, unknown>;
  result: ToolResult;
  toolUseId?: string;
  /** Root the file paths are shown relative to. */
  workspaceRoot?: string;
  durationMs?: number;
  /** The gateway refused the call (policy, boundary) before the tool ran. */
  blocked?: boolean;
  cancelled?: boolean;
}

const FILE_TOOLS: Record<string, FileOperation> = {
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  delete_file: "delete",
  move_file: "move",
};
const COMMAND_TOOLS = new Set(["terminal", "run_command"]);
const TAIL_CHARS = 2000;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
const lineCount = (text: string) => (text ? text.split(/\r?\n/).length - (text.endsWith("\n") ? 1 : 0) : 0);

/** A path as the user knows it: relative to the workspace, forward slashes, no server prefix. */
export function displayPath(raw: string, workspaceRoot?: string): string {
  let p = str(raw).trim();
  if (!p) return "";
  if (workspaceRoot) {
    const isWin = /^[A-Za-z]:[\\/]|^\\\\/.test(workspaceRoot);
    const lib = isWin ? path.win32 : path.posix;
    const root = workspaceRoot.replace(/[\\/]+$/, "");
    if (lib.isAbsolute(p)) {
      const rel = lib.relative(root, p);
      if (rel && !rel.startsWith("..") && !lib.isAbsolute(rel)) p = rel;
    }
  }
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

function tail(text: string): string {
  return text.length > TAIL_CHARS ? "…" + text.slice(-TAIL_CHARS) : text;
}

function firstLine(text: string, max = 160): string {
  const line = str(text).split(/\r?\n/).find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max) + "…" : line;
}

/** "Command failed (exit 2)", "exited (127)", "exit code 1" → the number. */
export function exitCodeFrom(result: ToolResult): number | null {
  if (result.ok) return 0;
  const m = /\bexit(?:ed)?(?: code)?\s*\(?\s*(-?\d+)/i.exec(`${str(result.error)}\n${str(result.output)}`);
  return m ? Number(m[1]) : null;
}

const NOT_RETRYABLE = /\b(ENOENT|not found|no such file|denied|refus|forbidden|EACCES|EPERM|escapes the workspace|outside the workspace|required|must not be empty|invalid|unknown tool|matched \d+ times|blocked identical retry|secret-like path|destructive command)\b/i;
const RETRYABLE = /\b(timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|EBUSY|socket hang up|network|temporarily|offline|not ready|changed externally|try again|rate limit|503|502|504)\b/i;

/** Could the same call succeed later? Only for transient failures, never for a wrong call. */
export function isRetryable(result: ToolResult, status: ToolResultEnvelopeStatus): boolean {
  if (status === "success" || status === "blocked" || status === "cancelled") return false;
  const text = `${str(result.error)}\n${str(result.output)}`;
  if (RETRYABLE.test(text)) return true;
  if (NOT_RETRYABLE.test(text)) return false;
  return false;
}

function fileEnvelopeParts(p: BuildEnvelopeParams, op: FileOperation, ok: boolean) {
  const { args, result } = p;
  const file = displayPath(str(args.path ?? args.file ?? args.from), p.workspaceRoot);
  const data: Record<string, unknown> = { operation: op, path: file };
  let summary = "";
  if (op === "read") {
    const content = str(result.output);
    if (ok) Object.assign(data, { bytes: Buffer.byteLength(content, "utf8"), lines: lineCount(content), sha256: sha256(content) });
    summary = ok ? `Read ${file} · ${data.lines} line${data.lines === 1 ? "" : "s"}` : `Could not read ${file}`;
  } else if (op === "write") {
    const content = str(args.content);
    const kind = result.edit?.kind ?? (/^OVERWROTE\b/.test(str(result.output)) ? "modify" : /^CREATED\b/.test(str(result.output)) ? "create" : undefined);
    Object.assign(data, { bytes: Buffer.byteLength(content, "utf8"), lines: lineCount(content), sha256: sha256(content), kind });
    summary = ok ? `${kind === "modify" ? "Overwrote" : "Wrote"} ${file} · ${data.bytes} bytes` : `Could not write ${file}`;
  } else if (op === "edit") {
    Object.assign(data, {
      additions: result.edit?.additions,
      deletions: result.edit?.deletions,
      replaceAll: args.replace_all === true || undefined,
    });
    const delta = result.edit ? ` · +${result.edit.additions} −${result.edit.deletions}` : "";
    summary = ok ? `Edited ${file}${delta}` : `Could not edit ${file}`;
  } else if (op === "delete") {
    summary = ok ? `Deleted ${file}` : `Could not delete ${file}`;
  } else {
    const to = displayPath(str(args.to), p.workspaceRoot);
    data.to = to;
    summary = ok ? `Moved ${file} → ${to}` : `Could not move ${file}`;
  }
  const evidence: ToolResultEvidence[] = ok && file
    ? [{ type: "file", label: "File", value: file, file, operation: op, extra: { ...data } }]
    : [];
  return { data, summary, evidence };
}

function commandEnvelopeParts(p: BuildEnvelopeParams, ok: boolean) {
  const command = str(p.args.command).trim();
  const exitCode = exitCodeFrom(p.result);
  const output = [str(p.result.output), ok ? "" : str(p.result.error)].filter(Boolean).join("\n");
  const timedOut = /timed out after/i.test(str(p.result.error));
  const service = p.result && (p.result as { service?: Record<string, unknown> }).service;
  const serviceUrl = /\bURL: (https?:\/\/\S+)/.exec(output)?.[1] ?? (service ? str(service.url) : "");
  const isService = Boolean(service) || /^(?:Service|Already running as) \S+/m.test(str(p.result.output));
  const data: Record<string, unknown> = {
    command,
    exitCode,
    timedOut: timedOut || undefined,
    outputBytes: Buffer.byteLength(output, "utf8"),
    outputTail: tail(output),
  };
  const evidence: ToolResultEvidence[] = [];
  if (command) {
    evidence.push({
      type: "command",
      label: "Shell command",
      value: command,
      command,
      operation: "run",
      extra: { exitCode, ok, timedOut: timedOut || undefined },
    });
  }
  if (ok && isService) {
    const serviceId = /\b((?:local_)?svc_\d+)\b/.exec(str(p.result.output))?.[1];
    data.service = { serviceId, url: serviceUrl || undefined };
    evidence.push({ type: "service", label: "Service", value: serviceUrl || serviceId || command, command, extra: { serviceId, url: serviceUrl || undefined } });
  }
  const summary = !command
    ? "Command"
    : isService && ok
      ? `Started ${command}${serviceUrl ? ` · ${serviceUrl}` : ""}`
      : ok
        ? `Ran ${command} · exit 0`
        : timedOut
          ? `${command} timed out`
          : `${command} failed${exitCode !== null ? ` · exit ${exitCode}` : ""}`;
  return { data, summary, evidence };
}

export function buildToolResultEnvelope(p: BuildEnvelopeParams): ToolResultEnvelope {
  const ok = Boolean(p.result.ok);
  const status: ToolResultEnvelopeStatus = ok ? "success" : p.cancelled ? "cancelled" : p.blocked ? "blocked" : "error";
  const modelPayload = ok ? str(p.result.output) : str(p.result.error) || "Tool execution failed";

  let parts: { data: Record<string, unknown>; summary: string; evidence: ToolResultEvidence[] };
  const fileOp = FILE_TOOLS[p.toolName];
  if (fileOp) parts = fileEnvelopeParts(p, fileOp, ok);
  else if (COMMAND_TOOLS.has(p.toolName)) parts = commandEnvelopeParts(p, ok);
  else {
    parts = {
      data: { outputBytes: Buffer.byteLength(str(p.result.output), "utf8") },
      summary: ok ? `${p.toolName} completed` : `${p.toolName} failed`,
      evidence: [],
    };
    for (const a of p.result.artifacts ?? []) {
      parts.evidence.push({ type: "artifact", label: "Artifact", value: a.name, extra: { artifactId: a.artifactId, mimeType: a.mimeType, size: a.size, sha256: a.sha256 } });
    }
  }

  if (!ok) {
    const reason = firstLine(str(p.result.error)) || "no error text";
    parts.summary = status === "blocked" ? `${parts.summary} · blocked: ${reason}` : status === "cancelled" ? `${parts.summary} · cancelled` : `${parts.summary}: ${reason}`;
    parts.data.error = str(p.result.error);
    parts.evidence.push({ type: "runtime_log", label: status === "blocked" ? "Blocked" : "Error", value: reason });
  }

  return {
    toolUseId: p.toolUseId,
    toolName: p.toolName,
    status,
    modelPayload,
    userSummary: parts.summary,
    structuredData: Object.fromEntries(Object.entries(parts.data).filter(([, v]) => v !== undefined)),
    evidence: parts.evidence,
    retryable: isRetryable(p.result, status),
    durationMs: p.durationMs,
  };
}

/** The envelope as stored on a run event: no model payload (it can be a whole file). */
export function envelopeForEvent(env: ToolResultEnvelope): Omit<ToolResultEnvelope, "modelPayload"> & { modelPayloadBytes: number } {
  const { modelPayload, ...rest } = env;
  return { ...rest, modelPayloadBytes: Buffer.byteLength(modelPayload, "utf8") };
}
