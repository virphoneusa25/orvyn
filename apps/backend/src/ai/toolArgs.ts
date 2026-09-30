// apps/backend/src/ai/toolArgs.ts
//
// Argument validation at the contract layer: every tool call that reaches
// the registry is checked against the tool's declared JSON schema (plus the
// fields a tool cannot run without). A malformed call is INVALID_ARGUMENTS —
// fixable by the caller, never a permission or execution failure.

export interface ToolParameterSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

const REQUIRED_BY_TOOL: Record<string, string[]> = {
  ssh_exec: ["host", "command"],
  remote_exec: ["resourceId", "command"],
  read_file: ["path"],
  write_file: ["path", "content"],
  edit_file: ["path"],
  delete_file: ["path"],
  terminal: ["command"],
  run_command: ["command"],
};

/**
 * Alternative arguments that satisfy a required field. write_file's schema
 * requires `content`, but the tool accepts `content_base64` as the binary
 * channel (attachment staging) — the contract is "content OR content_base64".
 */
const SATISFIES: Record<string, Record<string, string[]>> = {
  write_file: { content: ["content_base64"] },
};

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === "string" && value.trim() === "");
}

/** Schema required fields plus the arguments this tool cannot run without. */
export function requiredArgumentNames(name: string, schema?: ToolParameterSchema): string[] {
  return [...new Set([...(schema?.required ?? []), ...(REQUIRED_BY_TOOL[name] ?? [])])];
}

export function validateToolArguments(
  name: string,
  raw: unknown,
  schema?: ToolParameterSchema
): { ok: true; args: Record<string, unknown> } | {
  ok: false;
  error: string;
  errorType: "INVALID_ARGUMENTS";
  missing: string[];
  invalid: string[];
  retryable: true;
} {
  const args = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const required = requiredArgumentNames(name, schema);
  const missing: string[] = [];
  const invalid: string[] = [];
  for (const field of required) {
    const value = args[field];
    const alternates = SATISFIES[name]?.[field] ?? [];
    const satisfiedByAlternate = alternates.some((alt) => !isBlank(args[alt]));
    if (isBlank(value) && !satisfiedByAlternate) {
      missing.push(field);
      continue;
    }
    if (isBlank(value)) continue; // supplied via an alternate field
    const expected = schema?.properties?.[field]?.type;
    if (expected === "string" && typeof value !== "string") invalid.push(field);
    else if ((expected === "number" || expected === "integer") && (typeof value !== "number" || !Number.isFinite(value))) invalid.push(field);
    else if (expected === "boolean" && typeof value !== "boolean") invalid.push(field);
    else if (expected === "array" && !Array.isArray(value)) invalid.push(field);
    else if (expected === "object" && (value == null || typeof value !== "object" || Array.isArray(value))) invalid.push(field);
  }
  if (missing.length === 0 && invalid.length === 0) return { ok: true, args };
  const quote = (names: string[]) => names.map((field) => `"${field}"`).join(", ");
  const parts: string[] = [];
  if (missing.length) parts.push(`${name} is missing required argument${missing.length === 1 ? "" : "s"} ${quote(missing)}.`);
  if (invalid.length) parts.push(`${name} has invalid argument${invalid.length === 1 ? "" : "s"} ${quote(invalid)}.`);
  if (name === "ssh_exec" || name === "remote_exec") {
    parts.push("Do not call it with an empty host or command. If no server is connected, stop and ask for one.");
  }
  return { ok: false, error: parts.join(" "), errorType: "INVALID_ARGUMENTS", missing, invalid, retryable: true };
}
