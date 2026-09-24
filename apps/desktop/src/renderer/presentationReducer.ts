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
  timestamp: number;
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
  toolName?: string;
  output?: string;
  outputTruncated?: boolean;
  endedAt?: number;
  /** File extension badge (TS, JSON, MD…) when the target is a file. */
  ext?: string;
  fileName?: string;
  /** Directory portion, shown muted after the filename. */
  path?: string;
  /** Primary label for non-file operations (command, query, URL). */
  label?: string;
  status: "running" | "done" | "failed" | "stopped";
  /** Right-aligned result (e.g. "+14 −6", "12 results", "v24.18.0"). */
  detail?: string;
  error?: string;
  seq: number;
  ts: number;
  /** Which right-panel tab the row opens on click, if any. */
  ctx?: "files" | "diff" | "terminal" | "browser" | "review" | "documents" | "desktop" | "preview";
}

export interface GroupItem {
  kind: "group";
  key: string;
  op: ToolOp;
  items: ToolItem[];
}

/** A phase-level WorkGroup: consecutive same-class operations summarized as
 *  one calm line ("✓ Inspected project · 18 files · 2.4s") that expands to
 *  the individual rows. This is the spec's layer-1 conversation primitive. */
export interface WorkGroupItem {
  kind: "workgroup";
  key: string;
  /** inspection | checks | edits | browser */
  type: "inspection" | "checks" | "edits" | "browser";
  title: string;
  summary?: string;
  status: "running" | "done" | "warning" | "failed";
  durationMs?: number;
  items: ToolItem[];
  ctx?: "files" | "diff" | "terminal" | "browser" | "review" | "documents" | "desktop" | "preview";
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
  tone?: "working" | "stopped" | "rework" | "thought";
  /** Thought rows: a safe high-level summary with a duration — NEVER private
   *  chain-of-thought. Consecutive thinking events merge into one row. */
  thought?: { ts: number; endTs?: number; summary?: string };
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

export interface CapabilityRequiredItem {
  kind: "capability";
  key: string;
  query: string;
  reason: string;
  recommendedServers: { name?: string; server?: string; canonicalId?: string; freeInstall?: boolean }[];
  settled?: boolean;
}

export interface AttachmentItem {
  kind: "attachment";
  key: string;
  name: string;
  artifactId?: string;
  path?: string;
  mediaType?: string;
  downloadPath?: string;
  previewUrl?: string;
  kindLabel: string;
  size?: number;
  sha256?: string;
}

export type PresentationItem =
  | ToolItem
  | GroupItem
  | WorkGroupItem
  | AssistantItem
  | StatusItem
  | ApprovalItem
  | SummaryItem
  | CapabilityRequiredItem
  | AttachmentItem;

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

const READ_OPS: ToolOp[] = ["read", "search"]; // kept for callers/tests referencing the inspection class

/** Maps a tool name + its arguments to the row's operation and file target. */
function toolIdentity(name: string, args?: Record<string, any>): Partial<ToolItem> & { op: ToolOp } {
  const fileArg = (k = "path") => (typeof args?.[k] === "string" ? splitPath(String(args[k])) : undefined);
  switch (name) {
    case "read_document":
      return { op: "read", ...fileArg(), ctx: "documents" };
    case "create_document":
    case "create_zip":
      return { op: "create", ...fileArg("name"), ctx: "documents" };
    case "read_file":
      return { op: "read", ...fileArg(), ctx: "files" };
    // Open on a written/edited file shows the FILE (Files tab, new lines
    // highlighted); the diff stays one click away as "Changes".
    case "write_file":
      return { op: "create", ...fileArg(), ctx: "files" };
    case "edit_file":
    case "apply_edit":
      return { op: "edit", ...fileArg(), ctx: "files" };
    case "delete_file":
      return { op: "delete", ...fileArg(), ctx: "files" };
    case "move_file":
      return { op: "edit", ...fileArg("from"), ctx: "files" };
    case "rename_file":
      return { op: "edit", ...fileArg(), ctx: "files" };
    case "search_files":
    case "search_code":
    case "search_codebase":
    case "find_symbol":
    case "find_file":
    case "related_files":
    case "search_tests":
    case "get_project_outline":
    case "search":
      return { op: "search", label: String(args?.query ?? args?.pattern ?? args?.name ?? args?.path ?? ""), ctx: "files" };
    case "list_directory":
    case "list_files":
    case "list_symbols":
      return { op: "search", label: String(args?.path ?? ""), ctx: "files" };
    case "terminal":
    case "run_command":
    case "ssh_exec":
      return { op: "terminal", label: String(args?.command ?? ""), ctx: "terminal" };
    case "run_tests":
      return { op: "terminal", label: String(args?.command ?? "Run tests"), ctx: "terminal" };
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
    case "generate_image":
      return { op: "create", fileName: String(args?.filename ?? "image.png"), ctx: "files" };
    case "artifact_create":
    case "artifact_write":
      return { op: "create", ...fileArg("name"), ctx: "files" };
    case "artifact_list":
    case "artifact_read":
    case "artifact_get_download":
      return { op: "read", label: String(args?.id ?? args?.kind ?? "artifacts"), ctx: "files" };
    case "artifact_delete":
      return { op: "delete", label: String(args?.id ?? "artifact"), ctx: "files" };
    default:
      if (name.startsWith("desktop_") || name.startsWith("computer_") || name.startsWith("computer.")) {
        return { op: "browser", label: String(args?.url ?? name.replace(/^(desktop_|computer[._])/, "computer ")), ctx: "desktop" };
      }
      if (name.startsWith("browser_")) {
        const url = String(args?.url ?? "");
        const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
        return { op: "browser", label: url || name.replace(/^browser_/, ""), ctx: local ? "preview" : "browser" };
      }
      return { op: "other", label: name.replace(/_/g, " ") };
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

export function reducePresentation(events: AgentEventLike[], runStatus: string): PresentationItem[] {
  const items: PresentationItem[] = [];
  /** callId → index into `items` so lifecycle events update ONE row in place. */
  const toolIndex = new Map<string, number>();
  const startTs = events.length > 0 ? events[0].timestamp : Date.now();
  let assistantSeq = 0;
  let textBuf = "";

  /** Any real activity closes an open Thought row (fixes its duration). */
  const closeThought = (ts: number) => {
    const last = items[items.length - 1];
    if (last?.kind === "status" && last.thought && !last.thought.endTs) last.thought.endTs = ts;
  };

  const flushAssistant = (streaming: boolean) => {
    closeThought(0);
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
        // The first spoken word after a Thought closes it (its duration).
        if (!textBuf) closeThought(e.timestamp);
        textBuf += String(e.data.content ?? "");
        continue;
      case "message.completed":
        flushAssistant(false);
        continue;

      case "agent.phase": {
        flushAssistant(false);
        const note = String(e.data.note ?? e.data.phase ?? "Working");
        const last = items[items.length - 1];
        if (last?.kind === "status" && last.thought) {
          last.thought.endTs = e.timestamp;
          last.thought.summary = note.slice(0, 90);
          continue;
        }
        items.push({
          kind: "status",
          key: e.id,
          label: note.slice(0, 90) || "Working",
          ephemeral: false,
          tone: "thought",
          thought: { ts: e.timestamp, summary: note.slice(0, 90) },
        });
        continue;
      }

      case "thinking": {
        // High-level status only — never reasoning content. Consecutive
        // thinking events merge into ONE "Thought" row whose duration closes
        // when the next real activity arrives (spec Part 6).
        flushAssistant(false);
        const last = items[items.length - 1];
        if (last?.kind === "status" && last.thought) {
          last.thought.endTs = e.timestamp;
          const text = e.data.text ? String(e.data.text).slice(0, 90) : "";
          if (text) last.thought.summary = text;
          continue;
        }
        items.push({
          kind: "status",
          key: e.id,
          label: e.data.text ? String(e.data.text).slice(0, 90) : "Working",
          ephemeral: false,
          tone: "thought",
          thought: {
            ts: e.timestamp,
            summary: e.data.text ? String(e.data.text).slice(0, 90) : undefined,
          },
        });
        continue;
      }

      case "steer.queued":
        items.push({ kind: "status", key: e.id, label: `Steer queued: ${String(e.data.text ?? "").slice(0, 80)}`, ephemeral: false, tone: "working" });
        continue;
      case "steer.delivered":
        items.push({ kind: "status", key: e.id, label: `Steer applied: ${String(e.data.text ?? "").slice(0, 80)}`, ephemeral: false, tone: "working" });
        continue;

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
        items.push({ kind: "status", key: e.id, label: "Checking the result and making corrections…", ephemeral: false, tone: "rework" });
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
          if (it.kind === "tool" && (it.op === "edit" || it.op === "create") && it.fileName && path.replace(/\\/g, "/") === `${it.path ?? ""}${it.fileName}`) {
            if (detail) it.detail = detail;
            break;
          }
        }
        continue;
      }

      case "capability.required": {
        closeThought(e.timestamp);
        items.push({
          kind: "capability",
          key: String(e.id),
          query: String(e.data.query ?? ""),
          reason: String(e.data.reason ?? "ORION needs an additional capability."),
          recommendedServers: Array.isArray(e.data.recommendedServers) ? (e.data.recommendedServers as CapabilityRequiredItem["recommendedServers"]) : [],
        });
        continue;
      }

      case "approval.required": {
        closeThought(e.timestamp);
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
        closeThought(e.timestamp);
        const key = String(e.data.callId ?? e.id);
        const base = toolIdentity(String(e.data.tool ?? ""));
        items.push({
          kind: "tool",
          key,
          status: "running",
          toolName: String(e.data.tool ?? ""),
          seq: e.sequence,
          ts: e.timestamp,
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
          Object.assign(item, toolIdentity(String(e.data.tool ?? item.toolName ?? item.op), e.data.input));
        }
        continue;
      }
      case "tool.completed": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool") {
          if (item.status !== "failed") item.status = "done";
          item.endedAt = e.timestamp;
          item.output = typeof e.data.output === "string" ? e.data.output.slice(-16000) : item.output;
          item.outputTruncated = item.outputTruncated || Boolean(e.data.outputTruncated) || (typeof e.data.output === "string" && e.data.output.length > 16000);
          if (e.data.artifactName) {
            item.fileName = String(e.data.artifactName);
            item.detail = item.toolName === "generate_image"
              ? `Generated ${e.data.artifactName}`
              : `Created ${e.data.artifactName}`;
          } else {
            const preview = typeof e.data.preview === "string" ? e.data.preview : undefined;
            const det = detailFromPreview(item.op, preview);
            if (det) item.detail = det;
          }
        }
        const artifactId = e.data.artifactId ? String(e.data.artifactId) : undefined;
        const artifactName = e.data.artifactName ? String(e.data.artifactName) : e.data.name ? String(e.data.name) : undefined;
        if (artifactId && !items.some((it) => it.kind === "attachment" && it.artifactId === artifactId)) {
          flushAssistant(false);
          items.push({
            kind: "attachment",
            key: `att-${e.id}`,
            name: artifactName || "file",
            artifactId,
            mediaType: e.data.mimeType ? String(e.data.mimeType) : undefined,
            downloadPath: `/artifacts/${artifactId}/download`,
            previewUrl: `/artifacts/${artifactId}/preview`,
            kindLabel: String(e.data.kind ?? (item?.toolName === "generate_image" ? "generated" : "file")),
            size: typeof e.data.size === "number" ? e.data.size : undefined,
          });
        }
        continue;
      }
      case "files.ready": {
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: String(e.data.message ?? `${e.data.name ?? "File"} is in Files → Generated (virtual file storage).`),
          ephemeral: false,
          tone: "working",
        });
        continue;
      }
      case "message.grounded": {
        const lastAssistant = [...items].reverse().find((it) => it.kind === "assistant") as AssistantItem | undefined;
        if (lastAssistant && typeof e.data.content === "string") {
          lastAssistant.content = String(e.data.content);
          lastAssistant.streaming = false;
        }
        continue;
      }
      case "tool.failed": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        const item = at !== undefined ? (items[at] as ToolItem | undefined) : undefined;
        if (item?.kind === "tool") {
          item.status = "failed";
          item.endedAt = e.timestamp;
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

      case "terminal.output":
      case "terminal.completed": {
        const at = toolIndex.get(String(e.data.callId ?? ""));
        // Older runs lacked call ids; only associate an unambiguous command.
        const candidates = items.filter((it): it is ToolItem => it.kind === "tool" && it.op === "terminal");
        const item = at !== undefined ? items[at] : candidates.length === 1 ? candidates[0] : undefined;
        if (item?.kind === "tool" && item.op === "terminal") {
          if (e.type === "terminal.output") {
            const output = (item.output ?? "") + String(e.data.data ?? "");
            item.output = output.slice(-16000);
            item.outputTruncated = item.outputTruncated || output.length > 16000 || Boolean(e.data.truncated);
          } else {
            item.endedAt = e.timestamp;
            if (e.data.exitOk === false) {
              item.status = "failed";
              item.detail = "Command failed";
            }
          }
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
          ts: e.timestamp,
          ctx: "terminal",
        });
        continue;
      }

      case "run.completed":
        closeThought(e.timestamp);
        items.push({
          kind: "summary",
          key: e.id,
          ok: e.data.missionStatus !== "BLOCKED" && !(Number(e.data.tasksFailed) > 0),
          cancelled: false,
          detail: e.data.missionStatus === "BLOCKED" ? "Needs your attention — work is blocked"
            : Number(e.data.tasksFailed) > 0 ? "Finished with incomplete tasks"
            : Number(e.data.tasksTotal) > 0 ? `Completed — ${Number(e.data.tasksCompleted ?? 0)}/${Number(e.data.tasksTotal)} tasks`
            : "Completed",
        });
        continue;
      case "run.blocked":
        closeThought(e.timestamp);
        items.push({
          kind: "summary",
          key: e.id,
          ok: false,
          cancelled: false,
          detail: String(e.data.message ?? "Blocked — a resource is required"),
        });
        continue;
      case "run.error":
        closeThought(e.timestamp);
        items.push({
          kind: "summary",
          key: e.id,
          ok: false,
          cancelled: false,
          detail: String(e.data.message ?? "The run failed"),
        });
        continue;
      case "run.cancelled":
        closeThought(e.timestamp);
        items.push({ kind: "summary", key: e.id, ok: false, cancelled: true, detail: "Stopped" });
        continue;

      case "model.capability.blocked": {
        flushAssistant(false);
        const model = String(e.data.modelId ?? e.data.provider ?? "Selected model");
        const pinned = Boolean(e.data.pinned);
        const vision = e.data.capability === "vision";
        items.push({
          kind: "status",
          key: e.id,
          label: vision
            ? `Model · ${model} cannot inspect images`
            : pinned
              ? `Model · ${model} cannot use computer control here`
              : `Model · ${model} cannot use computer control here`,
          ephemeral: false,
        });
        continue;
      }
      case "model.fallback": {
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: `Model · Switched to ${String(e.data.actualModel ?? "a compatible model")} for visual verification`,
          ephemeral: false,
          tone: "working",
        });
        continue;
      }
      case "desktop.started":
      case "desktop.ready":
        flushAssistant(false);
        items.push({ kind: "status", key: e.id, label: "Computer use · Starting Desktop", ephemeral: false, tone: "working" });
        continue;
      case "desktop.screenshot":
        flushAssistant(false);
        items.push({ kind: "status", key: e.id, label: "Desktop · Inspecting app", ephemeral: false, tone: "working" });
        continue;
      case "desktop.returned":
        flushAssistant(false);
        items.push({ kind: "status", key: e.id, label: "Desktop · Returned to ORION", ephemeral: false, tone: "working" });
        continue;
      case "desktop.control.changed": {
        flushAssistant(false);
        const to = String(e.data.to ?? e.data.controlOwner ?? "");
        items.push({
          kind: "status",
          key: e.id,
          label: to === "user" ? "Desktop · Take Control — ORION input paused" : "Desktop · Returned to ORION",
          ephemeral: false,
          tone: "working",
        });
        continue;
      }
      case "desktop.verification.started":
        flushAssistant(false);
        items.push({ kind: "status", key: e.id, label: "Desktop · Verification started", ephemeral: false, tone: "working" });
        continue;
      case "desktop.verification.failed":
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: `Desktop · Verification failed${e.data.reason ? ` — ${String(e.data.reason).slice(0, 80)}` : ""}`,
          ephemeral: false,
        });
        continue;
      case "desktop.verification.passed":
        flushAssistant(false);
        items.push({ kind: "status", key: e.id, label: "Desktop · Verification passed", ephemeral: false });
        continue;
      case "preview.available":
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: `Browser · Opened ${String(e.data.url ?? e.data.previewUrl ?? "localhost")}`,
          ephemeral: false,
          tone: "working",
        });
        continue;
      case "run.execution":
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: `Execution · ${String(e.data.executionLabel ?? e.data.executionTargetActual ?? e.data.location ?? "Local")}${e.data.fallbackReason ? ` — ${String(e.data.fallbackReason).slice(0, 80)}` : ""}`,
          ephemeral: false,
          tone: "working",
        });
        continue;
      case "completion.blocked":
        flushAssistant(false);
        items.push({
          kind: "status",
          key: e.id,
          label: `Needs proof · ${String(Array.isArray(e.data.reasons) ? e.data.reasons[0] : e.data.gate ?? "completion gate")}`,
          ephemeral: false,
          tone: "rework",
        });
        continue;

      case "artifact.created":
      case "image.generated": {
        const artifactId = e.data.artifactId ? String(e.data.artifactId) : e.data.id ? String(e.data.id) : undefined;
        const name = String(e.data.name ?? e.data.filename ?? "").trim();
        if (!artifactId) continue;
        if (artifactId && items.some((it) => it.kind === "attachment" && it.artifactId === artifactId)) continue;
        flushAssistant(false);
        items.push({
          kind: "attachment",
          key: `att-${e.id}`,
          name: name || "file",
          artifactId,
          path: e.data.path ? String(e.data.path) : undefined,
          mediaType: e.data.mimeType ? String(e.data.mimeType) : e.data.mediaType ? String(e.data.mediaType) : undefined,
          downloadPath: e.data.downloadPath ? String(e.data.downloadPath) : e.data.downloadUrl ? String(e.data.downloadUrl) : `/artifacts/${artifactId}/download`,
          previewUrl: e.data.previewUrl ? String(e.data.previewUrl) : `/artifacts/${artifactId}/preview`,
          kindLabel: String(e.data.kind ?? (e.type === "image.generated" ? "generated" : "file")),
          size: typeof e.data.size === "number" ? e.data.size : undefined,
          sha256: e.data.sha256 ? String(e.data.sha256) : undefined,
        });
        continue;
      }

      default:
        // mission.*, task.*, agent.*, usage.*, context.*, file.* domain
        // duplicates, sandbox.* — internal telemetry; never rendered.
        continue;
    }
  }

  // A run still streaming keeps its open assistant buffer as the live item.
  const active = ["running", "awaiting_approval", "queued", "cancelling"].includes(runStatus);
  flushAssistant(active);
  if (!active) {
    for (const item of items) {
      if (item.kind === "tool" && item.status === "running") item.status = "stopped";
    }
  }
  const last = items[items.length - 1];
  if (active && (!last || (last.kind !== "status" && !(last.kind === "assistant" && last.streaming))) &&
      !items.some(it => it.kind === "tool" && it.status === "running")) {
    items.push({ kind: "status", key: "live-status", ephemeral: true, tone: "working",
      label: runStatus === "awaiting_approval" ? "Waiting for your approval" : runStatus === "queued" ? "Waiting to start…" : runStatus === "cancelling" ? "Stopping…" : "Thinking…" });
  }

  // Phase pass: consecutive same-class operations roll into one WorkGroup —
  // "✓ Inspected project · 18 files" — so a mission reads as a conversation,
  // not a scroll of rows. Assistant text and other items close the group.
  return phaseWorkGroups(dropStaleEphemeral(items).filter(it => active || it.kind !== "status" || !it.ephemeral));
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
  const lastEphemeral = items.reduce((last, it, i) => it.kind === "status" && it.ephemeral ? i : last, -1);
  return items.filter((it, i) => it.kind !== "status" || !(it as StatusItem).ephemeral || (i >= lastMeaningful && i === lastEphemeral));
}

/** Which phase a tool row belongs to; null keeps the row standalone. */
function workClass(t: ToolItem): WorkGroupItem["type"] | null {
  if (t.op === "read" || t.op === "search") return "inspection";
  if (t.op === "terminal" || t.op === "test" || t.op === "git") return "checks";
  if (t.op === "edit" || t.op === "create" || t.op === "delete") return "edits";
  if (t.op === "browser") return "browser";
  return null;
}

/** Sums "+A −D" details across an edits group. */
function sumEdits(items: ToolItem[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const it of items) {
    const m = (it.detail ?? "").match(/\+(\d+)\s*−(\d+)/);
    if (m) {
      adds += Number(m[1]);
      dels += Number(m[2]);
    }
  }
  return { adds, dels };
}

export function fmtDuration(ms: number): string | undefined {
  if (ms < 1000) return undefined;
  return ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.round(ms / 60_000)}m`;
}

function makeWorkGroup(type: WorkGroupItem["type"], items: ToolItem[]): WorkGroupItem {
  const anyRunning = items.some((i) => i.status === "running");
  const anyFailed = items.some((i) => i.status === "failed" || i.status === "stopped");
  const allFailed = anyFailed && items.every((i) => i.status === "failed");
  const status: WorkGroupItem["status"] = anyRunning ? "running" : allFailed ? "failed" : anyFailed ? "warning" : "done";
  const durationMs = items.length > 0 ? Math.max(...items.map(i => i.endedAt ?? i.ts)) - items[0].ts : 0;
  const dur = fmtDuration(durationMs);

  let title = "";
  let summary: string | undefined;
  if (type === "inspection") {
    const files = items.filter((i) => i.op === "read").length;
    const searches = items.filter((i) => i.op === "search").length;
    title = "Explore";
    const parts = [
      searches > 0 ? `${searches} ${searches === 1 ? "search" : "searches"}` : "",
      files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : "",
    ].filter(Boolean);
    summary = parts.join(", ") || undefined;
  } else if (type === "checks") {
    if (items.length === 1) {
      const label = items[0].label ?? "command";
      title = anyRunning ? `Running ${label}…` : label;
      summary = items[0].detail;
    } else {
      title = anyRunning ? "Running checks…" : "Checks";
      summary = items
        .map((i) => i.detail)
        .filter(Boolean)
        .slice(0, 3)
        .join(" · ");
    }
  } else if (type === "edits") {
    const { adds, dels } = sumEdits(items);
    const delta = adds || dels ? `+${adds} −${dels}` : "";
    if (items.length === 1 && items[0].fileName) {
      title = anyRunning ? `Updating ${items[0].fileName}…` : `Updated ${items[0].fileName}`;
      summary = delta || items[0].detail;
    } else {
      title = anyRunning ? "Updating files…" : `Updated ${items.length} files`;
      summary = `${items.length} files changed${delta ? ` · ${delta}` : ""}`;
    }
  } else {
    // browser
    const last = items[items.length - 1];
    title = anyRunning ? "Verifying in browser…" : "Browser verification";
    summary = last?.label || last?.detail || undefined;
  }
  if (dur) summary = summary ? `${summary} · ${dur}` : dur;

  if (anyFailed && !anyRunning) title = type === "edits" ? "File changes need attention" : type === "inspection" ? "Inspection needs attention" : "Activity needs attention";

  const ctxByType: Record<WorkGroupItem["type"], WorkGroupItem["ctx"]> = {
    inspection: "files",
    checks: "terminal",
    edits: "diff",
    browser: "browser",
  };
  return {
    kind: "workgroup",
    key: `wg-${items[0].key}`,
    type,
    title,
    summary,
    status,
    durationMs,
    items,
    // One changed file opens that file; several open the combined Changes view.
    ctx: type === "edits"
      ? (new Set(items.map((i) => `${i.path ?? ""}${i.fileName ?? ""}`)).size > 1 ? "diff" : "files")
      : items[0].ctx ?? ctxByType[type],
  };
}

/** Rolls consecutive same-class tool rows into single WorkGroups. */
function phaseWorkGroups(items: PresentationItem[]): PresentationItem[] {
  const out: PresentationItem[] = [];
  let buf: ToolItem[] = [];
  let cls: WorkGroupItem["type"] | null = null;
  const flush = () => {
    if (buf.length > 0 && cls) out.push(makeWorkGroup(cls, buf));
    buf = [];
    cls = null;
  };
  for (const it of items) {
    if (it.kind === "tool") {
      const c = workClass(it);
      if (c !== null && (cls === null || c === cls)) {
        if (cls === null) cls = c;
        buf.push(it);
        continue;
      }
      flush();
      if (c !== null) {
        cls = c;
        buf.push(it);
        continue;
      }
      out.push(it); // unclassified rows stand alone
      continue;
    }
    flush();
    out.push(it);
  }
  flush();
  return out;
}
