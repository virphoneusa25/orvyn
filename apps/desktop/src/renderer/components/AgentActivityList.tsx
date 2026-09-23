// Shared renderer for agent tool/file/terminal events so Chat and Agent
// both show "Editing …" / "Running …" instead of swallowing them.
import React, { useState } from "react";
import { MessageContent } from "./MessageContent";
import { IconSearch, IconFile, IconTerminal, IconCheck, IconClose } from "./Icons";
import { apiUrl, authHeaders } from "../connection";
import { reducePresentation, fmtDuration, type ApprovalItem, type CapabilityRequiredItem, type AttachmentItem } from "../presentationReducer";
import { openArtifactInContext } from "../contextOpen";
import { ToolActivityRow, ToolActivityGroup, WorkGroupRow } from "./ToolActivityRow";

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
  // RAW EVENTS → presentation items → rows. Raw event names, timestamps,
  // task/mission/agent internals and reviewer text never render directly;
  // tool lifecycles collapse into single rows that update in place.
  const items = React.useMemo(() => reducePresentation(events, status), [events, status]);

  return (
    <>
      {items.map((item) => {
        switch (item.kind) {
          case "assistant":
            return (
              <div key={item.key} className="conversation-reply">
                <MessageContent content={item.content} streaming={item.streaming} />
              </div>
            );
          case "tool":
            return <ToolActivityRow key={item.key} item={item} />;
          case "group":
            return <ToolActivityGroup key={item.key} group={item} />;
          case "workgroup":
            return <WorkGroupRow key={item.key} group={item} />;
          case "status":
            if (item.ephemeral) return <div key={item.key} className="activity-thinking" role="status"><span className="activity-pulse" />{item.label}</div>;
            // Thought rows: while one is the live activity (no endTs, run
            // still streaming) it reads as an active state — "Working…" with
            // the pulse. Once real activity follows, it becomes the quiet
            // historical marker "Thought · 3s". The hover summary is a safe
            // one-line status label — never private reasoning.
            if (item.thought) {
              const live = !item.thought.endTs && (status === "running" || status === "awaiting_approval");
              const durMs = item.thought.endTs ? item.thought.endTs - item.thought.ts : 0;
              const dur = item.thought.endTs
                ? durMs < 1500
                  ? "a few seconds"
                  : durMs < 60_000
                    ? `${Math.round(durMs / 1000)} seconds`
                    : `${Math.round(durMs / 60_000)} minutes`
                : undefined;
              if (live) {
                return (
                  <div key={item.key} className="activity-thinking" role="status" title={item.thought.summary ?? "Working"}>
                    <span className="activity-pulse" />
                    {item.thought.summary ? `${item.thought.summary}…` : "Working…"}
                  </div>
                );
              }
              return (
                <div
                  key={item.key}
                  className="stream-thought"
                  title={item.thought.summary ?? "Worked"}
                >
                  <span aria-hidden="true">✦</span>
                  <span className="stream-thought-label">Thought</span>
                  <span>· {dur ?? "a few seconds"}</span>
                </div>
              );
            }
            return (
              <div
                key={item.key}
                style={{
                  fontSize: 11.5,
                  margin: "6px 0",
                  color:
                    item.tone === "stopped"
                      ? "var(--text-muted)"
                      : item.tone === "rework"
                        ? "var(--warning, #F5B942)"
                        : "var(--text-muted)",
                  fontStyle: "italic",
                }}
              >
                {item.tone === "rework" ? "↻ " : ""}
                {item.label}
              </div>
            );
          case "summary":
            return (
              <div
                key={item.key}
                style={{
                  fontSize: 11.5,
                  margin: "8px 0 4px",
                  color: item.cancelled ? "var(--text-muted)" : item.ok ? "var(--success)" : "var(--danger, #F25F75)",
                }}
              >
                {item.cancelled ? "■ " : item.ok ? "✓ " : "✕ "}
                {item.detail}
              </div>
            );
          case "approval":
            return <ApprovalCard key={item.key} item={item} onApprove={onApprove} />;
          case "capability":
            return <CapabilityCard key={item.key} item={item} />;
          case "attachment":
            return <ArtifactCard key={item.key} item={item} />;
          default:
            return null;
        }
      })}
    </>
  );
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactCard({ item }: { item: AttachmentItem }) {
  const [busy, setBusy] = useState(false);
  if (!item.artifactId) return null;
  const image = (item.mediaType ?? "").startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/i.test(item.name);
  const typeLabel = item.mediaType?.split("/")[1]?.toUpperCase() || (item.name.split(".").pop() ?? "FILE").toUpperCase();
  const meta = [typeLabel, formatBytes(item.size)].filter(Boolean).join(" · ");
  async function download() {
    if (!item.artifactId) return;
    setBusy(true);
    try {
      const r = await fetch(apiUrl(item.downloadPath || `/artifacts/${item.artifactId}/download`), { headers: authHeaders() });
      if (!r.ok) throw new Error("Download failed");
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = item.name;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      /* keep the card; user can retry from Files */
    } finally {
      setBusy(false);
    }
  }
  return (
    <div style={{ ...card("var(--orvyn-cyan, #22d3ee)"), display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <IconFile />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{item.name}</div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{meta || (item.kindLabel === "generated" ? "Generated" : "Artifact")}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <button style={ghostBtn()} onClick={() => openArtifactInContext({ tab: "files", path: item.path, fileName: item.name, artifactId: item.artifactId, op: "create" })}>Preview</button>
        <button style={ghostBtn()} disabled={busy} onClick={() => void download()}>{busy ? "Downloading…" : "Download"}</button>
        <button style={ghostBtn()} onClick={() => openArtifactInContext({ tab: "files", path: item.path, fileName: item.name, artifactId: item.artifactId, op: "create" })}>Show in Files</button>
      </div>
    </div>
  );
}

function CapabilityCard({ item }: { item: CapabilityRequiredItem }) {
  const [settled, setSettled] = useState(Boolean(item.settled));
  const primary = item.recommendedServers[0]?.name || item.recommendedServers[0]?.server || "this integration";
  const free = Boolean((item.recommendedServers[0] as { freeInstall?: boolean } | undefined)?.freeInstall) || /no API key/i.test(item.reason);
  const openMarket = (query: string) => {
    document.dispatchEvent(new CustomEvent("orvyn:marketplace-open", { detail: { query, reason: item.reason } }));
  };
  return (
    <div style={card("var(--accent)")}>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
        ORION needs {primary} to {item.query || "continue"}.
      </div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10, lineHeight: 1.45 }}>
        {item.reason}
        {free ? " Official public MCP tools install on this desktop with no API key." : ""}
      </div>
      {settled ? (
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Cancelled — ORION will not install this itself.</span>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button onClick={() => openMarket(primary)} style={btn("var(--accent)")}>
            {free ? `Install ${primary}` : `Connect ${primary}`}
          </button>
          <button onClick={() => openMarket(item.query || primary)} style={btn("var(--border)")}>
            View MCP options
          </button>
          <button onClick={() => setSettled(true)} style={btn("var(--border)")}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: (callId: string, approved: boolean, scope?: "once" | "mission") => void | Promise<void>;
}) {
  const preview = item.preview as EditPreview | undefined;
  // PENDING → APPROVING → APPROVED/DENIED; a failed request re-enables the
  // buttons (the run-level error surfaces separately) — never a silent click.
  const [busy, setBusy] = useState(false);
  const act = (approved: boolean, scope?: "once" | "mission") => {
    setBusy(true);
    Promise.resolve(onApprove(item.key, approved, scope)).finally(() => setBusy(false));
  };
  return (
    <div style={card(item.destructive ? "var(--danger)" : "var(--accent)")}>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
        {item.destructive ? "Destructive action requested" : "Agent wants to run"}
      </div>
      {preview ? (
        <div style={{ marginBottom: 8 }}>
          <DiffPreview preview={preview} collapsible={false} />
        </div>
      ) : (
        <code style={{ ...mono(), display: "block", marginBottom: 8, whiteSpace: "pre-wrap" }}>
          {item.tool}({JSON.stringify(item.input).slice(0, 400)})
        </code>
      )}
      {item.settled ? (
        <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {item.approved ? "Approved" : "Denied"}
        </span>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button disabled={busy} onClick={() => act(true)} style={btn("var(--accent)")}>
            {busy ? "Approving…" : (<><IconCheck size={12} /> Allow Once</>)}
          </button>
          {!item.destructive && (
            <button disabled={busy} onClick={() => act(true, "mission")} style={btn("var(--border)")}>
              Allow for Mission
            </button>
          )}
          <button disabled={busy} onClick={() => act(false)} style={btn("var(--border)")}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}

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
