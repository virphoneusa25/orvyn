export interface AgentProgressEvent {
  id?: string;
  runId?: string;
  sequence?: number;
  type: string;
  timestamp?: number;
  data?: Record<string, any>;
}

export type ProgressState = "pending" | "running" | "done" | "failed" | "waiting";
export type ProgressKind = "plan" | "file" | "command" | "search" | "review" | "approval" | "image" | "other";
export interface ProgressRow {
  id: string;
  kind: ProgressKind;
  integration?: "github";
  label: string;
  detail?: string;
  state: ProgressState;
  approvalCallId?: string;
}

const TOOL_LABELS: Record<string, string> = {
  list_directory: "Checking project files",
  search_files: "Searching the codebase",
  search_capabilities: "Using search capabilities",
  search_code: "Searching code",
  web_search: "Searching the web",
  fetch_url: "Reading a page",
  generate_image: "Generating image",
  create_document: "Creating document",
  create_zip: "Creating archive",
  read_file: "Reading file",
  write_file: "Creating file",
  edit_file: "Editing file",
  delete_file: "Deleting file",
  move_file: "Moving file",
  terminal: "Running command",
  run_tests: "Running tests",
  git_status: "Checking Git status",
  git_diff: "Reviewing changes",
  browser_screenshot: "Checking the app in a browser",
};

function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function toolKind(tool: string): ProgressRow["kind"] {
  if (/^(generate_image)$/.test(tool)) return "image";
  if (/^(write_file|edit_file|delete_file|move_file|read_file|create_document|create_zip|artifact_create|artifact_write)$/.test(tool)) return "file";
  if (/^(terminal|run_tests|ssh_exec|remote_exec|start_process|run_command)$/.test(tool)) return "command";
  if (/^(web_search|fetch_url|search_files|search_code|search_capabilities)$/.test(tool)) return "search";
  if (/^(git_diff|git_status|browser_screenshot|verify)$/.test(tool)) return "review";
  return "other";
}

function toolIntegration(tool: string): ProgressRow["integration"] {
  return /^mcp\.(?:[^.]*github[^.]*)\./i.test(tool) ? "github" : undefined;
}

function toolLabel(tool: string): string {
  const github = tool.match(/^mcp\.(?:[^.]*github[^.]*)\.(.+)$/i);
  if (github) return `Using GitHub: ${github[1]!.replace(/[._]/g, " ")}`;
  return TOOL_LABELS[tool] ?? `Using ${tool.replace(/[._]/g, " ")}`;
}

function toolDetail(input: Record<string, unknown>): string | undefined {
  const command = str(input.command);
  if (command) return `$ ${command}`.slice(0, 400);
  const path = str(input.path);
  if (path) return path.slice(0, 300);
  const url = str(input.url);
  if (url) return url.slice(0, 300);
  return undefined;
}

/** Convert backend events to the concise, safe steps shown in Cloud chat. */
export function progressRows(events: AgentProgressEvent[], status = "running"): ProgressRow[] {
  const work: ProgressRow[] = [];
  const byCall = new Map<string, ProgressRow>();
  const inputs = new Map<string, Record<string, unknown>>();
  const byKey = new Map<string, ProgressRow>();
  const put = (row: ProgressRow) => {
    const at = work.findIndex((item) => item.id === row.id);
    if (at < 0) work.push(row); else work[at] = row;
    byKey.set(row.id, row);
  };

  for (const event of events) {
    const data = event.data ?? {};
    const callId = str(data.callId);
    if (event.type === "tool.input" && callId && data.input && typeof data.input === "object") {
      inputs.set(callId, data.input as Record<string, unknown>);
      const row = byCall.get(callId);
      if (row) row.detail = toolDetail(data.input as Record<string, unknown>) ?? row.detail;
      continue;
    }
    if (event.type === "tool.started" && callId) {
      const tool = str(data.tool) || "tool";
      const args = (data.args && typeof data.args === "object" ? data.args : inputs.get(callId)) as Record<string, unknown> | undefined;
      const row: ProgressRow = {
        id: `tool:${callId}`,
        kind: toolKind(tool),
        integration: toolIntegration(tool),
        label: toolLabel(tool),
        detail: args ? toolDetail(args) : undefined,
        state: "running",
      };
      byCall.set(callId, row);
      put(row);
      continue;
    }
    if ((event.type === "tool.completed" || event.type === "tool.failed") && callId) {
      const tool = str(data.tool) || "tool";
      const row = byCall.get(callId) ?? {
        id: `tool:${callId}`, kind: toolKind(tool), integration: toolIntegration(tool), label: toolLabel(tool),
      } as ProgressRow;
      row.state = event.type === "tool.failed" ? "failed" : "done";
      const summary = str(data.envelope?.userSummary ?? data.summary ?? data.preview);
      if (summary) row.detail = summary.slice(0, 400);
      byCall.set(callId, row);
      put(row);
      continue;
    }
    if (event.type === "file.edit" || event.type === "file.created") {
      const path = str(data.path);
      if (path && !work.some((r) => r.kind === "file" && r.detail === path)) {
        put({ id: `file:${path}`, kind: "file", label: event.type === "file.created" ? "Created file" : "Updated file", detail: path.slice(0, 300), state: "done" });
      }
      continue;
    }
    if (event.type === "terminal.started" || event.type === "terminal.completed") {
      const key = `terminal:${str(data.callId) || String(event.sequence ?? work.length)}`;
      put({ id: key, kind: "command", label: event.type === "terminal.started" ? "Running command" : "Command finished", detail: str(data.command) ? `$ ${str(data.command)}`.slice(0, 400) : undefined, state: event.type === "terminal.started" ? "running" : "done" });
      continue;
    }
    if (event.type === "verification.completed" || event.type === "review.passed" || event.type === "review.rejected") {
      const verdict = str(data.verdict).toUpperCase();
      const ok = event.type === "review.passed" || verdict === "PASS";
      put({ id: `review:${event.sequence ?? work.length}`, kind: "review", label: ok ? "Reviewed changes" : "Reviewing changes", detail: verdict || undefined, state: event.type === "review.rejected" || (verdict && verdict !== "PASS") ? "failed" : "done" });
      continue;
    }
    if (event.type === "approval.required") {
      put({ id: `approval:${callId || event.sequence}`, kind: "approval", label: "Waiting for approval", detail: str(data.tool) ? TOOL_LABELS[str(data.tool)] ?? str(data.tool) : undefined, state: "waiting", approvalCallId: callId || undefined });
    } else if (event.type === "approval.resolved" && callId) {
      const row = byKey.get(`approval:${callId}`);
      if (row) row.state = data.approved === true ? "done" : "failed";
    }
  }

  if (!events.length) return work;
  const collapsed = collapseSameHostFetchFailures(work);
  const cursor = timelineCursor(events, status);
  const intro: ProgressState = cursor === "introducing" ? "running" : "done";
  const checking: ProgressState = cursor === "checking" ? "running" : cursor === "done" ? "done" : cursor === "failed" ? "failed" : "pending";
  // Flat ledger: each action is its own permanent row. Tools are not nested
  // under an Acting accordion — they sit between Introducing and Checking.
  return [
    { id: "stage:introducing", kind: "plan", label: "Introducing", state: intro },
    ...collapsed,
    { id: "stage:checking", kind: "review", label: "Checking the result", state: checking },
  ];
}

function hostOfUrl(value?: string): string {
  const raw = String(value ?? "");
  try { return new URL(raw).hostname.replace(/^www\./i, ""); } catch { /* fall through */ }
  const m = /https?:\/\/([^/\s]+)/i.exec(raw);
  return (m?.[1] ?? raw).replace(/^www\./i, "").split("/")[0] ?? "";
}

function publicFetchDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  if (/OpenShell|host \*|request_network_access|fetch_url/i.test(detail)) {
    const host = hostOfUrl(detail);
    return host ? `Could not read ${host} — the site blocked automated access.` : "Could not read the page.";
  }
  return detail.slice(0, 180);
}

/** Four 401s on the same site collapse to one failed read in the conversation. */
function collapseSameHostFetchFailures(work: ProgressRow[]): ProgressRow[] {
  const out: ProgressRow[] = [];
  const failedHosts = new Set<string>();
  for (const row of work) {
    if (row.kind === "search" && row.label === "Reading a page" && row.state === "failed") {
      const host = hostOfUrl(row.detail);
      if (host && failedHosts.has(host)) continue;
      if (host) failedHosts.add(host);
      out.push({ ...row, detail: publicFetchDetail(row.detail) });
      continue;
    }
    out.push(row);
  }
  return out;
}

function timelineCursor(events: AgentProgressEvent[], status: string): "introducing" | "acting" | "checking" | "done" | "failed" {
  if (status === "error" || status === "failed") return "failed";
  if (terminalRunStatus(status) || events.some((e) => e.type === "run.completed" || e.type === "run.partial")) return "done";
  let stage: "introducing" | "acting" | "checking" = "introducing";
  for (const event of events) {
    const phase = str(event.data?.phase ?? event.data?.note).toLowerCase();
    if (event.type === "run.phase.changed" || event.type === "agent.phase") {
      if (/introduc|plan|preflight|prepare/.test(phase)) stage = "introducing";
      else if (/verif|repair|review|check/.test(phase)) stage = "checking";
      else if (/act|observ|execut|wait/.test(phase)) stage = "acting";
    }
    if (event.type === "tool.started" && stage === "introducing") stage = "acting";
    if (event.type === "verification.started" || event.type === "verification.completed" || event.type === "review.passed") stage = "checking";
  }
  return stage;
}

function phaseLabel(phase: string): string {
  const key = phase.toLowerCase();
  if (key.includes("introduc")) return "Writing a reply";
  if (key.includes("plan")) return "Planning the work";
  if (key === "acting" || key === "observing") return "Working on your request";
  if (key.includes("review") || key.includes("verif") || key.includes("repair")) return "Checking the result";
  if (key.includes("complete") || key.includes("settle")) return "Finishing up";
  if (key.includes("wait")) return "Waiting for you";
  return phase.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Compact live label from the latest phase — never a completed-step checklist. */
export function liveStatusLabel(events: AgentProgressEvent[], status: string): string | undefined {
  if (terminalRunStatus(status)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "run.phase.changed" && event.type !== "agent.phase") continue;
    const phase = str(event.data?.phase ?? event.data?.note ?? event.data?.label);
    if (phase) return phaseLabel(phase);
  }
  return "Writing a reply";
}

export function terminalRunStatus(status: string): boolean {
  return ["completed", "partial", "error", "failed", "cancelled", "blocked"].includes(status);
}
