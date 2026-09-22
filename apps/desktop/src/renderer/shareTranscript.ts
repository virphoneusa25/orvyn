// apps/desktop/src/renderer/shareTranscript.ts
//
// Build a shareable conversation transcript. Never include session tokens,
// API keys, private env, or hidden reasoning.

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  attachments?: { path?: string; kind?: string }[];
}

export interface TranscriptEvent {
  type: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface TranscriptInput {
  title?: string;
  runId?: string | null;
  messages: TranscriptMessage[];
  events?: TranscriptEvent[];
}

const SECRET_PATTERNS: RegExp[] = [
  /orvsess_[A-Za-z0-9._-]+/g,
  /Bearer\s+[A-Za-z0-9._\-+=/]+/gi,
  /(?:api[_-]?key|access[_-]?token|secret|password|passwd|authorization)["\s:=]+["']?[^\s"']{6,}/gi,
  /ORVYN_[A-Z0-9_]*KEY=\S+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /AKIA[0-9A-Z]{16}/g,
];

const HIDDEN_EVENT = /reasoning|thought|hidden|chain.of.thought|delta\.think|tokens?/i;

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

function isHiddenEvent(type: string): boolean {
  return HIDDEN_EVENT.test(type);
}

function eventLine(e: TranscriptEvent): string | null {
  if (isHiddenEvent(e.type)) return null;
  const d = e.data ?? {};
  if (e.type === "tool.completed") {
    const tool = String(d.tool ?? "tool");
    const preview = redactSecrets(String(d.preview ?? d.output ?? "")).split("\n")[0]!.slice(0, 160);
    return preview ? `Tool ${tool}: ${preview}` : `Tool ${tool} completed`;
  }
  if (e.type === "tool.failed") {
    return `Tool ${String(d.tool ?? "tool")} failed: ${redactSecrets(String(d.error ?? "")).slice(0, 140)}`;
  }
  if (e.type === "file.edit") {
    const preview = d.preview as { path?: string; additions?: number; deletions?: number } | undefined;
    if (preview?.path) return `Edited ${preview.path} (+${preview.additions ?? 0}/−${preview.deletions ?? 0})`;
    return `Edited ${String(d.path ?? "file")}`;
  }
  if (e.type === "file.read") return `Read ${String(d.path ?? "file")}`;
  if (e.type === "terminal.output") {
    return `Terminal: ${redactSecrets(String(d.chunk ?? d.output ?? "")).slice(0, 140)}`;
  }
  if (e.type === "run.completed") return "Run completed";
  if (e.type === "run.error") return `Run error: ${redactSecrets(String(d.message ?? "")).slice(0, 140)}`;
  if (e.type === "approval.required") return `Approval required: ${String(d.tool ?? "tool")}`;
  return null;
}

export function buildMarkdownTranscript(input: TranscriptInput): string {
  const lines: string[] = ["# ORVYN transcript"];
  if (input.title) lines.push("", input.title);
  if (input.runId) lines.push("", `Run ID: \`${input.runId}\``);
  lines.push("");
  for (const m of input.messages) {
    const who = m.role === "user" ? "User" : "ORION";
    lines.push(`## ${who}`, "", redactSecrets(m.content || "").trim() || "_(empty)_", "");
    if (m.attachments?.length) {
      lines.push(`_Attachments: ${m.attachments.map((a) => a.path || a.kind || "file").join(", ")}_`, "");
    }
  }
  const eventLines = (input.events ?? []).map(eventLine).filter((x): x is string => Boolean(x));
  if (eventLines.length) {
    lines.push("## Work", "");
    for (const line of eventLines) lines.push(`- ${line}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function buildJsonTranscript(input: TranscriptInput): string {
  const events = (input.events ?? [])
    .filter((e) => !isHiddenEvent(e.type))
    .map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      summary: eventLine(e),
    }))
    .filter((e) => e.summary);
  const payload = {
    title: input.title ?? "ORVYN transcript",
    runId: input.runId ?? null,
    messages: input.messages.map((m) => ({
      role: m.role,
      content: redactSecrets(m.content || ""),
      attachments: m.attachments?.map((a) => ({ path: a.path, kind: a.kind })) ?? [],
    })),
    events,
  };
  return JSON.stringify(payload, null, 2);
}

export interface DiagnosticsInput {
  runId?: string | null;
  backendHost?: string;
  mode?: string;
  workspaceName?: string | null;
  engineState?: string;
  cloudMode?: boolean;
}

export function buildDiagnostics(input: DiagnosticsInput): string {
  return [
    "ORVYN diagnostics",
    input.runId ? `Run ID: ${input.runId}` : "Run ID: (none)",
    input.backendHost ? `Backend: ${input.backendHost}` : "Backend: unknown",
    `Mode: ${input.cloudMode ? "cloud" : "local"}`,
    input.workspaceName ? `Workspace: ${input.workspaceName}` : "Workspace: none",
    input.engineState ? `Engine: ${input.engineState}` : null,
    input.mode ? `Composer mode: ${input.mode}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export function conversationHasContent(input: TranscriptInput): boolean {
  return input.messages.some((m) => m.content.trim()) || Boolean(input.runId);
}
