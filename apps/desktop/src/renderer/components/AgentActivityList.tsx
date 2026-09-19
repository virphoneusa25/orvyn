// Shared renderer for agent tool/file/terminal events so Chat and Agent
// both show "Editing …" / "Running …" instead of swallowing them.
import React, { useState } from "react";
import { MessageContent } from "./MessageContent";
import { IconSearch, IconFile, IconTerminal, IconCheck, IconClose } from "./Icons";
import { apiUrl, authHeaders } from "../connection";

export interface AgentEvent {
  id: string;
  runId: string;
  sequence: number;
  type: string;
  timestamp: number;
  data: Record<string, any>;
}

const TOOL_LABEL: Record<string, string> = {
  list_directory: "Listing directory",
  search_files: "Searching codebase",
  read_file: "Reading",
  write_file: "Editing",
  edit_file: "Editing",
  delete_file: "Deleting",
  move_file: "Moving",
  terminal: "Running",
  git_status: "Checking git status",
  git_diff: "Reading git diff",
  git_commit: "Committing",
  generate_image: "Generating image",
  ssh_exec: "Running over SSH",
};

interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

interface EditPreview {
  path: string;
  kind: "create" | "modify" | "delete" | "move";
  additions: number;
  deletions: number;
  diff?: DiffLine[];
  truncated?: boolean;
  note?: string;
}

const KIND_LABEL: Record<EditPreview["kind"], string> = {
  create: "Create",
  modify: "Modify",
  delete: "Delete",
  move: "Move",
};

/**
 * Renders a proposed file change as a diff. This is what makes an approval
 * reviewable — approving a `write_file` from its JSON arguments alone means
 * approving a change you cannot see.
 */
function DiffPreview({ preview, collapsible = true }: { preview: EditPreview; collapsible?: boolean }) {
  const [open, setOpen] = React.useState(!collapsible);
  const hasDiff = Array.isArray(preview.diff) && preview.diff.length > 0;

  return (
    <div style={{ marginTop: 6, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, flexWrap: "wrap" }}>
        <span style={{ color: "var(--text-muted)" }}>{KIND_LABEL[preview.kind] ?? "Change"}</span>
        <code style={{ ...mono(), color: "var(--text)" }}>{preview.path}</code>
        {preview.additions > 0 && <span style={{ color: "var(--success)" }}>+{preview.additions}</span>}
        {preview.deletions > 0 && <span style={{ color: "var(--danger)" }}>−{preview.deletions}</span>}
        {hasDiff && collapsible && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: "1px solid var(--border-strong)",
              borderRadius: "var(--radius)",
              color: "var(--text-secondary)",
              fontSize: 11,
              padding: "2px 8px",
              cursor: "pointer",
            }}
          >
            {open ? "Hide diff" : "Show diff"}
          </button>
        )}
      </div>

      {preview.note && (
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>{preview.note}</div>
      )}

      {hasDiff && open && (
        <pre
          style={{
            marginTop: 6,
            marginBottom: 0,
            background: "var(--bg-app)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            lineHeight: 1.5,
            maxHeight: 280,
            overflow: "auto",
          }}
        >
          {preview.diff!.map((line, i) => (
            <div
              key={i}
              style={{
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                color:
                  line.type === "add"
                    ? "var(--success)"
                    : line.type === "remove"
                    ? "var(--danger)"
                    : "var(--text-muted)",
                background:
                  line.type === "add"
                    ? "rgba(63,185,80,0.10)"
                    : line.type === "remove"
                    ? "rgba(240,84,106,0.10)"
                    : "transparent",
              }}
            >
              {line.type === "add" ? "+" : line.type === "remove" ? "−" : " "} {line.content}
            </div>
          ))}
          {preview.truncated && (
            <div style={{ color: "var(--text-muted)", marginTop: 4 }}>… diff truncated for display …</div>
          )}
        </pre>
      )}
    </div>
  );
}

export function liveActivityLabel(events: AgentEvent[]): string | null {
  const completed = new Set(
    events
      .filter((e) => e.type === "tool.completed" || e.type === "tool.failed")
      .map((e) => e.data.callId)
  );
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "tool.started" && !completed.has(e.data.callId)) {
      const tool = String(e.data.tool);
      const input = events.find((x) => x.type === "tool.input" && x.data.callId === e.data.callId);
      const detail = input ? String(Object.values(input.data.input ?? {})[0] ?? "") : "";
      return `${TOOL_LABEL[tool] ?? tool}${detail ? ` ${detail}` : ""}`;
    }
    if (e.type === "file.edit") return `Editing ${String(e.data.path ?? "")}`;
    if (e.type === "file.read") return `Reading ${String(e.data.path ?? "")}`;
    if (e.type === "terminal.started") return `Running ${String(e.data.command ?? "")}`;
    if (e.type === "thinking") return "Thinking…";
  }
  return null;
}

export function AgentActivityList({
  events,
  status,
  onApprove,
}: {
  events: AgentEvent[];
  status: string;
  onApprove: (callId: string, approved: boolean, scope?: "once" | "mission") => void;
}) {
  const resolvedApprovals = new Set(
    events.filter((e) => e.type === "approval.resolved").map((e) => e.data.callId)
  );

  const nodes: React.ReactNode[] = [];
  let textBuf = "";
  let textKey = 0;

  const flushText = (streaming: boolean) => {
    if (!textBuf) return;
    const body = textBuf;
    textBuf = "";
    nodes.push(
      <div key={`narration-${textKey++}`} style={{ margin: "8px 0 12px", fontSize: 13, minWidth: 0, color: "var(--text)" }}>
        <MessageContent content={body} streaming={streaming} />
      </div>
    );
  };

  for (const e of events) {
    if (e.type === "message.delta") {
      textBuf += String(e.data.content ?? "");
      continue;
    }
    if (e.type === "message.completed") {
      flushText(false);
      continue;
    }

    const cardNode = renderEvent(e, events, resolvedApprovals, onApprove);
    if (cardNode) {
      flushText(false);
      nodes.push(cardNode);
    }
  }
  flushText(status === "running" || status === "awaiting_approval");

  return <>{nodes}</>;
}

function renderEvent(
  e: AgentEvent,
  events: AgentEvent[],
  resolvedApprovals: Set<unknown>,
  onApprove: (callId: string, approved: boolean, scope?: "once" | "mission") => void
): React.ReactNode {
  switch (e.type) {
    case "run.started":
      return (
        <div key={e.id} style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
          Run started{e.data.mode ? ` · ${String(e.data.mode)}` : ""} · {String(e.data.instruction)}
        </div>
      );

    case "thinking": {
      const role = e.data.role ? String(e.data.role) : "";
      const step = e.data.step != null ? `step ${String(e.data.step)}` : "";
      const model = e.data.model ? String(e.data.model) : "";
      const label = role || step;
      return (
        <div key={e.id} style={{ fontSize: 12, color: "var(--text-muted)", margin: "8px 0" }}>
          Thinking…{label ? ` (${label})` : ""}
          {model ? ` · ${model}` : ""}
        </div>
      );
    }

    case "file.read":
      return (
        <div key={e.id} style={card("var(--border)")}>
          <span style={{ color: "var(--accent)", display: "inline-flex", marginRight: 8 }}>
            <IconFile size={14} />
          </span>
          Reading <code style={mono()}>{String(e.data.path)}</code>
        </div>
      );

    case "file.edit": {
      const preview = e.data.preview as EditPreview | undefined;
      return (
        <div key={e.id} style={card("var(--accent)")}>
          <div style={{ display: "flex", alignItems: "center", minWidth: 0 }}>
            <span style={{ color: "var(--accent)", display: "inline-flex", marginRight: 8 }}>
              <IconFile size={14} />
            </span>
            Editing <code style={{ ...mono(), marginLeft: 4 }}>{String(e.data.path)}</code>
          </div>
          {preview && <DiffPreview preview={preview} />}
        </div>
      );
    }

    case "terminal.started":
      return (
        <div key={e.id} style={card("var(--border)")}>
          <span style={{ color: "var(--accent)", display: "inline-flex", marginRight: 8 }}>
            <IconTerminal size={14} />
          </span>
          Running <code style={mono()}>{String(e.data.command)}</code>
        </div>
      );

    case "tool.started": {
      const tool = String(e.data.tool);
      const label = TOOL_LABEL[tool] ?? tool;
      const input = events.find((x) => x.type === "tool.input" && x.data.callId === e.data.callId);
      const detail: string | undefined = input ? String(Object.values(input.data.input ?? {})[0] ?? "") : undefined;
      const done = events.find(
        (x) => (x.type === "tool.completed" || x.type === "tool.failed") && x.data.callId === e.data.callId
      );
      const failed = done?.type === "tool.failed";
      return (
        <div key={e.id} style={card(failed ? "var(--danger)" : "var(--border)")}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
            <span style={{ color: failed ? "var(--danger)" : "var(--accent)", display: "flex", flexShrink: 0 }}>
              {tool === "terminal" ? <IconTerminal size={14} /> : tool.includes("search") ? <IconSearch size={14} /> : <IconFile size={14} />}
            </span>
            <span style={{ fontSize: 12.5, flexShrink: 0 }}>{label}</span>
            {detail && (
              <code style={{ ...mono(), overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {String(detail).slice(0, 80)}
              </code>
            )}
            <span style={{ marginLeft: "auto", fontSize: 11, color: failed ? "var(--danger)" : "var(--success)", flexShrink: 0 }}>
              {done ? (failed ? "failed" : "done") : "…"}
            </span>
          </div>
          {failed && (
            <div style={{ fontSize: 11.5, color: "var(--danger)", marginTop: 6 }}>
              {String(done?.data.error).slice(0, 200)}
            </div>
          )}
        </div>
      );
    }

    case "terminal.output":
      return (
        <pre key={e.id} style={termBox()}>
          {String(e.data.data).slice(0, 1200)}
        </pre>
      );

    case "approval.required": {
      const callId = String(e.data.callId);
      const settled = resolvedApprovals.has(callId);
      const destructive = Boolean(e.data.destructive);
      const preview = e.data.preview as EditPreview | undefined;
      return (
        <div key={e.id} style={card(destructive ? "var(--danger)" : "var(--accent)")}>
          <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
            {destructive ? "Destructive action requested" : "Agent wants to run"}
          </div>
          {/* A file change is shown as a diff; anything else falls back to its
              arguments, which is all there is to show for a shell command. */}
          {preview ? (
            <div style={{ marginBottom: 8 }}>
              <DiffPreview preview={preview} collapsible={false} />
            </div>
          ) : (
            <code style={{ ...mono(), display: "block", marginBottom: 8, whiteSpace: "pre-wrap" }}>
              {String(e.data.tool)}({JSON.stringify(e.data.input).slice(0, 400)})
            </code>
          )}
          {settled ? (
            <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Resolved</span>
          ) : (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={() => onApprove(callId, true)} style={btn("var(--accent)")}>
                <IconCheck size={12} /> Allow Once
              </button>
              {/* Destructive commands are never mission-approvable — the
                  backend would re-prompt anyway, so don't offer the button. */}
              {!destructive && (
                <button onClick={() => onApprove(callId, true, "mission")} style={btn("transparent")}>
                  <IconCheck size={12} /> Allow for Mission
                </button>
              )}
              <button onClick={() => onApprove(callId, false)} style={btn("transparent")}>
                <IconClose size={12} /> Deny
              </button>
            </div>
          )}
        </div>
      );
    }

    case "plan.created": {
      const tasks = (e.data.tasks ?? []) as { id: string; description: string }[];
      return (
        <div key={e.id} style={card("var(--accent)")}>
          <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 6 }}>
            Plan · {tasks.length} tasks
            <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
              {String(e.data.plannerModel ?? "")}
            </span>
          </div>
          {tasks.map((t, i) => (
            <div key={t.id} style={{ fontSize: 12, color: "var(--text-secondary)", padding: "2px 0" }}>
              {i + 1}. {t.description}
            </div>
          ))}
        </div>
      );
    }

    case "task.started":
      return (
        <div key={e.id} style={{ fontSize: 12, color: "var(--text)", margin: "10px 0 4px", fontWeight: 500 }}>
          ▶ {String(e.data.description)}
          {Number(e.data.attempt) > 1 && (
            <span style={{ color: "var(--warning)", marginLeft: 6 }}>retry {String(e.data.attempt)}</span>
          )}
        </div>
      );

    case "review.started":
      return (
        <div key={e.id} style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0" }}>
          Reviewing…{e.data.reviewerModel ? ` · ${String(e.data.reviewerModel)}` : ""}
        </div>
      );

    case "review.passed":
      return (
        <div key={e.id} style={{ fontSize: 12, color: "var(--success)", margin: "4px 0" }}>
          ✓ Review passed{e.data.notes ? ` — ${String(e.data.notes).slice(0, 100)}` : ""}
        </div>
      );

    case "review.rejected":
      return (
        <div key={e.id} style={card("var(--warning)")}>
          <div style={{ fontSize: 12, color: "var(--warning)", fontWeight: 500 }}>Review rejected</div>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)", marginTop: 4 }}>
            {String(e.data.notes)}
          </div>
        </div>
      );

    case "image.generated":
      return (
        <div key={e.id} style={card("var(--accent)")}>
          Generating image: {String(e.data.prompt ?? "").slice(0, 160)}
        </div>
      );

    case "run.error":
      return (
        <div key={e.id} style={errBox()}>
          {String(e.data.message)}
        </div>
      );

    case "run.cancelled":
      return (
        <div
          key={e.id}
          style={{
            background: "rgba(210,153,34,0.10)",
            border: "1px solid var(--warning)",
            borderRadius: "var(--radius)",
            padding: 10,
            fontSize: 12,
            marginBottom: 10,
            color: "var(--warning)",
          }}
        >
          Run stopped{e.data.reason ? ` — ${String(e.data.reason)}` : ""}. Any edits already applied were kept.
        </div>
      );

    // Told explicitly, because an agent that silently forgot half its history
    // looks like an agent that lost the plot.
    case "context.compacted":
      return (
        <div key={e.id} style={{ fontSize: 11.5, color: "var(--text-muted)", margin: "6px 0" }}>
          Compacted context to stay within the window ·{" "}
          {Number(e.data.tokensBefore).toLocaleString()} → {Number(e.data.tokensAfter).toLocaleString()} tokens
          {Number(e.data.droppedTurns) > 0 ? ` · ${String(e.data.droppedTurns)} older exchange(s) dropped` : ""}
        </div>
      );

    default:
      return null;
  }
}

/**
 * The action row under a finished run — the "4 files changed +77 −15 · Undo ·
 * copy · 👍/👎 · time" strip. Changes are aggregated from the run's file.edit
 * previews; Undo restores the pre-run snapshot taken when the run started.
 */
export function RunFooter({
  events,
  runId,
  finished,
  onAfterUndo,
}: {
  events: AgentEvent[];
  runId: string | null;
  finished: boolean;
  /** Called after a successful undo so the parent can refresh open files. */
  onAfterUndo?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<"up" | "down" | null>(null);
  const [undoState, setUndoState] = useState<
    { busy: boolean; result?: string; error?: string } | null
  >(null);

  if (!finished) return null;

  const endEvent = [...events].reverse().find((e) => e.type === "run.completed");
  const time = endEvent
    ? new Date(endEvent.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  // Aggregate the diff previews the backend attached to file.edit events.
  const edits = new Map<string, { additions: number; deletions: number }>();
  for (const e of events) {
    if (e.type !== "file.edit") continue;
    const p = e.data.preview as EditPreview | undefined;
    if (!p) continue;
    const key = p.path || String(e.data.path ?? "");
    const prev = edits.get(key) ?? { additions: 0, deletions: 0 };
    edits.set(key, { additions: prev.additions + (p.additions || 0), deletions: prev.deletions + (p.deletions || 0) });
  }
  let additions = 0;
  let deletions = 0;
  for (const v of edits.values()) {
    additions += v.additions;
    deletions += v.deletions;
  }
  const hasChanges = edits.size > 0;

  const fullText = events
    .filter((e) => e.type === "message.delta")
    .map((e) => String(e.data.content ?? ""))
    .join("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullText.trim());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be denied; the button simply does nothing then.
    }
  }

  async function sendFeedback(kind: "up" | "down") {
    setFeedback(kind);
    if (runId) {
      fetch(apiUrl(`/agent/stream/runs/${runId}/feedback`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ kind }),
      }).catch(() => {
        // Feedback is fire-and-forget; the local toggle still records intent.
      });
    }
  }

  async function undo() {
    if (!runId || undoState?.busy) return;
    setUndoState({ busy: true });
    try {
      const res = await fetch(apiUrl(`/agent/stream/runs/${runId}/undo`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Undo failed");
      const removed = Array.isArray(data.removed) ? data.removed.length : 0;
      setUndoState({
        busy: false,
        result: `Reverted ${(data.restored ?? []).length} file(s)${removed ? `, removed ${removed} created` : ""}`,
      });
      onAfterUndo?.();
    } catch (err: any) {
      setUndoState({ busy: false, error: err.message });
    }
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "8px 2px 2px",
        marginTop: 4,
        borderTop: "1px solid var(--border)",
        fontSize: 11.5,
        color: "var(--text-muted)",
      }}
    >
      {hasChanges && (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            background: "var(--bg-elevated)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "3px 10px",
          }}
          title={[...edits.keys()].join("\n")}
        >
          {edits.size} {edits.size === 1 ? "file" : "files"} changed
          <span style={{ color: "var(--success)" }}>+{additions}</span>
          <span style={{ color: "var(--danger)" }}>−{deletions}</span>
        </span>
      )}

      {hasChanges &&
        (undoState?.result ? (
          <span style={{ color: "var(--success)" }}>{undoState.result}</span>
        ) : undoState?.error ? (
          <span style={{ color: "var(--danger)" }}>{undoState.error}</span>
        ) : (
          <button
            onClick={() => void undo()}
            disabled={undoState?.busy || !runId}
            style={ghostBtn()}
            title="Restore the working tree to the pre-run snapshot"
          >
            <IconClose size={11} /> {undoState?.busy ? "Undoing…" : "Undo"}
          </button>
        ))}

      <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 8 }}>
        {time && <span>{time}</span>}
        <button onClick={() => void copy()} style={ghostBtn()} title="Copy the run's reply">
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={() => void sendFeedback(feedback === "up" ? "down" : "up")}
          style={{ ...ghostBtn(), color: feedback === "up" ? "var(--success)" : undefined }}
          title="Good run"
        >
          👍
        </button>
        <button
          onClick={() => void sendFeedback("down")}
          style={{ ...ghostBtn(), color: feedback === "down" ? "var(--danger)" : undefined }}
          title="Bad run"
        >
          👎
        </button>
      </span>
    </div>
  );
}

function ghostBtn(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    background: "transparent",
    border: "1px solid var(--border)",
    borderRadius: 999,
    color: "var(--text-secondary)",
    padding: "3px 10px",
    fontSize: 11,
    cursor: "pointer",
  };
}

function card(border: string): React.CSSProperties {
  return {
    border: `1px solid ${border}`,
    borderRadius: "var(--radius)",
    background: "var(--bg-elevated)",
    padding: 10,
    marginBottom: 8,
    minWidth: 0,
    overflow: "hidden",
  };
}
function mono(): React.CSSProperties {
  return { fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--text-secondary)" };
}
function termBox(): React.CSSProperties {
  return {
    background: "var(--bg-app)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    padding: 10,
    margin: "0 0 8px",
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    whiteSpace: "pre-wrap",
    color: "var(--text-secondary)",
    maxHeight: 220,
    overflowY: "auto",
  };
}
function errBox(): React.CSSProperties {
  return {
    background: "rgba(240,84,106,0.10)",
    border: "1px solid var(--danger)",
    borderRadius: "var(--radius)",
    padding: 10,
    fontSize: 12,
    marginBottom: 10,
  };
}
function btn(bg: string): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: bg,
    border: bg === "transparent" ? "1px solid var(--border-strong)" : "none",
    borderRadius: "var(--radius)",
    color: bg === "transparent" ? "var(--text-secondary)" : "var(--accent-fg)",
    padding: "6px 12px",
    fontSize: 12,
  };
}
