// apps/desktop/src/renderer/presentationReducer.ts
//
// RAW EVENT BUS → ConversationPresentationReducer → presentation items.
//
// The center work stream is a CONVERSATION, not a debug console: raw events
// (mission.created, task.started, agent.tool_call, event ids, timestamps…)
// never render directly. This pure function folds a run's event log into the
// small set of things a user should see — assistant text, compact tool rows
// that update IN PLACE, approvals, statuses, and a final summary — grouping
// excessive reads so 50 file inspections don't become 50 rows.
//
// Pure and dependency-free so it is unit-testable in isolation.

export interface AgentEventLike {
  id: string;
  sequence: number;
  type: string;
  data: Record<string, any>;
}

export type ToolOp =
  | "read"
  | "create"
  | "edit"
  | "delete"
  | "search"
  | "terminal"
  | "browser"
  | "git"
  | "test"
  | "other";

export interface ToolItem {
  kind: "tool";
  key: string;
  op: ToolOp;
  /** File extension badge (TS, JSON, MD…) when the target is a file. */
  ext?: string;
  fileName?: string;
  /** Directory portion, shown muted after the filename. */
  path?: string;
  /** Primary label for non-file operations (command, query, URL). */
  label?: string;
  status: "running" | "done" | "failed";
  /** Right-aligned result (e.g. "+14 −6", "12 results", "v24.18.0"). */
  detail?: string;
  error?: string;
  seq: number;
  /** Which right-panel tab the row opens on click, if any. */
  ctx?: "files" | "diff" | "terminal" | "browser" | "review";
}

export interface GroupItem {
  kind: "group";
  key: string;
  op: ToolOp;
  items: ToolItem[];
}

export interface AssistantItem {
  kind: "assistant";
  key: string;
  content: string;
  streaming: boolean;
}

export interface StatusItem {
  kind: "status";
  key: string;
  label: string;
  /** Ephemeral statuses (Analyzing…) render only while they are the newest thing. */
  ephemeral: boolean;
  tone?: "working" | "stopped" | "rework";
}

export interface ApprovalItem {
  kind: "approval";
  key: string;
  tool: string;
  input: unknown;
  destructive: boolean;
  preview?: unknown;
  settled: boolean;
  approved?: boolean;
}

export interface SummaryItem {
  kind: "summary";
  key: string;
  ok: boolean;
  cancelled: boolean;
  detail: string;
}

export type PresentationItem = ToolItem | GroupItem | AssistantItem | StatusItem | ApprovalItem | SummaryItem;

// ---- helpers -------------------------------------------------------------

/** "src/auth/session.ts" → { fileName: "session.ts", path: "src/auth/", ext: "TS" } */
export function splitPath(p: string): { fileName: string; path: string; ext?: string } {
  const norm = p.replace(/\\/g, "/");
  const slash = norm.lastIndexOf("/");
  const fileName = slash >= 0 ? norm.slice(slash + 1) : norm;
  const path = slash >= 0 ? norm.slice(0, slash + 1) : "";
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toUpperCase() : undefined;
  return { fileName, path, ext };
}

const READ_OPS: ToolOp[] = ["read", "search"];

/** Maps a tool name + its arguments to the row's operation and file target. */
function toolIdentity(name: string, args?: Record<string, any>): Partial<ToolItem> & { op: ToolOp } {
  const fileArg = (k = "path") => (typeof args?.[k] === "string" ? splitPath(String(args[k])) : undefined);
  switch (name) {
    case "read_file":
      return { op: "read", ...fileArg(), ctx: "files" };
    case "write_file":
      return { op: "create", ...fileArg(), ctx: "diff" };
    case "edit_file":
    case "apply_edit":
      return { op: "edit", ...fileArg(), ctx: "diff" };
    case "delete_file":
      return { op: "delete", ...fileArg(), ctx: "files" };
    case "rename_file":
      return { op: "edit", ...fileArg(), ctx: "files" };
    case "search_files":
    case "search_code":
    case "search":
      return { op: "search", label: String(args?.query ?? args?.pattern ?? ""), ctx: "files" };
    case "list_directory":
    case "list_files":
    case "list_symbols":
      return { op: "search", label: String(args?.path ?? ""), ctx: "files" };
    case "terminal":
    case "run_command":
    case "ssh_exec":
      return { op: "terminal", label: String(args?.command ?? ""), ctx: "terminal" };
    case "run_tests":
      return { op: "terminal", label: "npm test", ctx: "terminal" };
    case "run_typecheck":
      return { op: "terminal", label: "typecheck", ctx: "terminal" };
    case "run_linter":
      return { op: "terminal", label: "lint", ctx: "terminal" };
    case "git_status":
      return { op: "git", label: "git status", ctx: "files" };
    case "git_diff":
      return { op: "git", label: "git diff", ctx: "diff" };
    case "git_log":
      return { op: "git", label: "git log", ctx: "files" };
    case "git_branch":
      return { op: "git", label: "git branch", ctx: "files" };
    case "git_commit":
      return { op: "git", label: "git commit", ctx: "files" };
    default:
      return name.startsWith("browser_")
        ? { op: "browser", label: String(args?.url ?? name.replace(/^browser_/, "")), ctx: "browser" }
        : { op: "other", label: name };
  }
}

/** Pulls a compact right-aligned detail from a tool result preview. */
function detailFromPreview(op: ToolOp, preview?: string): string | undefined {
  if (!preview) return undefined;
  const text = preview.trim();
  if (op === "search") {
    if (/no matches/i.test(text)) return "0 results";
    const lines = text.split("\n").filter((l) => l.trim());
    if (lines.length > 1) return `${lines.length} results`;
    return text.slice(0, 40);
  }
  if (op === "terminal") return text.split("\n")[0]?.slice(0, 48) || undefined;
  return undefined;
}

// ---- the reducer ---------------------------------------------------------

const GROUP_THRESHOLD = 6; // >5 rapid related reads collapse into one row

export function reducePresentation(events: AgentEventLike[], runStatus: string): PresentationItem[] {
  const items: PresentationItem[] = [];
  /** callId → index into `items` so lifecycle events update ONE row in place. */
  const toolIndex = new Map<string, number>();
  let assistantSeq = 0;
  let textBuf = "";

  const flushAssistant = (streaming: boolean) => {
    if (!textBuf.trim()) {
      textBuf = "";
      return;
    }
    items.push({ kind: "assistant", key: `a-${assistantSeq++}`, content: textBuf, streaming });
    textBuf = "";
  };

  for (const e of events) {
    switch (e.type) {
      case "message.delta":
        textBuf += String(e.data.content ?? "");
        continue;
      case "message.completed":
        flushAssistant(false);
        continue;

      case "thinking": {
        // High-level status only — never reasoning content.
        const role = String(e.data.role ?? "");
        const label = e.data.text
          ? String(e.data.text)
          : !role || role === "astra" || role === "orchestrator"
            ? "Analyzing…"
            : `${role} working…`;
        items.push({ kind: "status", key: e.id, label, ephemeral: true, tone: "working" });
        continue;
      }

      case "run.queued":
        items.push({
          kind: "status",
          key: e.id,
          label: String(e.data.note ?? `Queued at position ${e.data.position ?? "?"}`),
          ephemeral: false,
          tone: "working",
        });
        continue;

      case "review.rejected":
        items.push({ kind: "status", key: e.id, label: "Astra requested another pass", ephemeral: false, tone: "rework" });
        continue;

      case "checkpoint.created":
        items.push({ kind: "status", key: e.id, label: "Checkpoint created — one-click Undo available", ephemeral: false });
        continue;

      case "file.edit": {
        // Domain event carrying the real diff counts; attach +N −M to the
        // matching edit/create row (the tool lifecycle itself has no counts).
        const path = String(e.data.path ?? "");
        const preview = e.data.preview as { additions?: number; deletions?: number } | undefined;
        const detail =
          preview && (preview.additions || preview.deletions)
            ? `+${preview.additions ?? 0} −${preview.deletions ?? 0}`
            : undefined;
        for (let i = items.length - 1; i >= 0; i--) {
          const it = items[i];
          if (it.kind === "tool" && (it.op === "edit" || it.op === "create") && it.fileName && path.endsWith(it.fileName)) {
            if (detail) it.detail = detail;
            break;
          }
        }
        continue;
      }

      case "approval.required": {
        flushAssistant(false);
        items.push({
          kind: "approval",
          key: String(e.data.callId ?? e.id),
          tool: String(e.data.tool ?? ""),
          input: e.data.input,
          destructive: Boolean(e.data.destructive),
          preview: e.data.preview,
          settled: false,
        });
        continue;
      }
      case "approval.resolved": {
        const target = items.find(
          (it) => it.kind === "approval" && it.key === String(e.data.callId)
        ) as ApprovalItem | undefined;
        if (target) {
          target.settled = true;
          target.approved = Boolean(e.data.approved);
        }
        continue;
      }

      case "tool.started": {
        flushAssistant(false);
        const key = String(e.data.callId ?? e.id);
        const base = toolIdentity(String(e.data.tool ?? ""));
        items.push({
          kind: "tool",
          key,
          status: "running",
          seq: e.sequence,
          ...base,
        });
        toolIndex.set(key, items.length - 1);
        continue;
      }
      case "tool.input": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool") {
          // The arguments carry the real file path / command — refine in place.
          Object.assign(item, toolIdentity(String(e.data.tool ?? item.op), e.data.input));
        }
        continue;
      }
      case "tool.completed": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool") {
          item.status = "done";
          const preview = typeof e.data.preview === "string" ? e.data.preview : undefined;
          const det = detailFromPreview(item.op, preview);
          if (det) item.detail = det;
        }
        continue;
      }
      case "tool.failed": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool") {
          item.status = "failed";
          item.error = String(e.data.error ?? "").slice(0, 200);
        } else if (String(e.data.tool) === "model") {
          // A worker model error surfaces as an actionable line, not silence.
          items.push({
            kind: "status",
            key: e.id,
            label: `Model error: ${String(e.data.error ?? "").slice(0, 120)}`,
            ephemeral: false,
          });
        }
        continue;
      }

      case "terminal.completed": {
        // exit status for streaming runs' command rows
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool" && item.op === "terminal" && !e.data.exitOk) {
          item.status = "failed";
          item.detail = "failed";
        }
        continue;
      }

      case "test.completed": {
        flushAssistant(false);
        const passed = Number(e.data.passed ?? 0);
        const failed = Number(e.data.failed ?? 0);
        items.push({
          kind: "tool",
          key: e.id,
          op: "test",
          label: String(e.data.suite ?? "Tests"),
          status: failed > 0 ? "failed" : "done",
          detail: failed > 0 ? `${failed} failed` : `${passed} passed`,
          seq: e.sequence,
          ctx: "terminal",
        });
        continue;
      }

      case "run.completed":
        flushAssistant(false);
        items.push({
          kind: "summary",
          key: e.id,
          ok: true,
          cancelled: false,
          detail: `Completed — ${Number(e.data.tasksCompleted ?? 0)}/${Number(e.data.tasksTotal ?? 0)} tasks`,
        });
        continue;
      case "run.error":
        flushAssistant(false);
        items.push({
          kind: "summary",
          key: e.id,
          ok: false,
          cancelled: false,
          detail: String(e.data.message ?? "The run failed"),
        });
        continue;
      case "run.cancelled":
        flushAssistant(false);
        items.push({ kind: "summary", key: e.id, ok: false, cancelled: true, detail: "Stopped" });
        continue;

      default:
        // mission.*, task.*, agent.*, usage.*, context.*, file.* domain
        // duplicates, sandbox.* — internal telemetry; never rendered.
        continue;
    }
  }

  // A run still streaming keeps its open assistant buffer as the live item.
  if (runStatus === "running" || runStatus === "awaiting_approval") flushAssistant(true);

  // Group rapid read/search bursts; edits and commands always stay visible.
  return groupReadBursts(dropStaleEphemeral(items));
}

/** Ephemeral statuses that were superseded by real activity disappear. */
function dropStaleEphemeral(items: PresentationItem[]): PresentationItem[] {
  const lastMeaningful = (() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const k = items[i].kind;
      if (k !== "status" || !(items[i] as StatusItem).ephemeral) return i;
    }
    return -1;
  })();
  return items.filter((it, i) => it.kind !== "status" || !(it as StatusItem).ephemeral || i >= lastMeaningful);
}

/** Collapses runs of >5 completed read/search rows into one expandable group. */
function groupReadBursts(items: PresentationItem[]): PresentationItem[] {
  const out: PresentationItem[] = [];
  let burst: ToolItem[] = [];
  const flushBurst = () => {
    if (burst.length === 0) return;
    if (burst.length <= GROUP_THRESHOLD - 1) {
      out.push(...burst);
    } else {
      out.push({ kind: "group", key: `g-${burst[0].key}`, op: "read", items: burst });
    }
    burst = [];
  };
  for (const it of items) {
    if (it.kind === "tool" && READ_OPS.includes(it.op) && it.status === "done") {
      burst.push(it);
      continue;
    }
    flushBurst();
    out.push(it);
  }
  flushBurst();
  return out;
}
