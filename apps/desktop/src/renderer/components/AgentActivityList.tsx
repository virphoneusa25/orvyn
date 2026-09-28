// Shared renderer for agent tool/file/terminal events so Chat and Agent
// both show "Editing …" / "Running …" instead of swallowing them.
import { SourcesBar } from "./SourcesBar";
import { ResearchTimeline } from "./ResearchTimeline";
import type { ResearchStep } from "../researchSteps";
import { domainOf } from "../runSources";
import { AnswerActions } from "./AnswerActions";
import { collectSources } from "../runSources";

/** ORION's final answer in a run: what it said after its last tool (or the whole reply). */
function finalAnswerText(events: AgentEvent[]): string {
  let lastTool = -1;
  events.forEach((e, i) => { if (e.type === "tool.completed" || e.type === "tool.failed") lastTool = i; });
  let text = "";
  events.forEach((e, i) => { if (e.type === "message.retracted") text = ""; else if (e.type === "message.delta" && i > lastTool) text += String(e.data.content ?? ""); });
  if (!text.trim()) text = events.filter((e) => e.type === "message.delta").map((e) => String(e.data.content ?? "")).join("");
  const grounded = [...events].reverse().find((e) => e.type === "message.grounded");
  return String(grounded?.data.content ?? text).trim();
}
import React, { useEffect, useState } from "react";
import { MessageContent } from "./MessageContent";
import { IconSearch, IconFile, IconTerminal, IconCheck, IconClose } from "./Icons";
import { apiUrl, authHeaders } from "../connection";
import { reducePresentation, fmtDuration, fileTypeLabel, type ApprovalItem, type CapabilityRequiredItem, type AttachmentItem } from "../presentationReducer";
import { ToolActivityRow, ToolActivityGroup, ToolRunGroup, WorkGroupRow } from "./ToolActivityRow";
import { changeTotals, groupToolRuns } from "../streamRows";
import { openArtifactInContext } from "../contextOpen";
import { ORION_THINKING_TEXT, ORION_WORKING_TEXT, OrbStatusSlot, orbMotionForLabel } from "./OrionThinkingIndicator";

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
  write_file: "Writing",
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

type ResearchGroup = { kind: "research"; key: string; steps: ResearchStep[] };

/** Consecutive web searches and page reads become one research timeline ("Searched the web, read 3 pages"). */
function groupResearch(items: ReturnType<typeof reducePresentation>): Array<ReturnType<typeof reducePresentation>[number] | ResearchGroup> {
  const out: Array<ReturnType<typeof reducePresentation>[number] | ResearchGroup> = [];
  for (const item of items) {
    const web = item.kind === "tool" && !item.verifier && (item.toolName === "web_search" || item.toolName === "fetch_url");
    if (!web) { out.push(item); continue; }
    const t = item as Extract<typeof item, { kind: "tool" }>;
    const status = t.status === "running" ? "running" : t.status === "done" ? "done" : "failed";
    const step: ResearchStep = t.toolName === "web_search"
      ? { id: t.key, kind: "search", status, label: t.label ?? "", results: Number(/(\d+)/.exec(t.detail ?? "")?.[1] ?? 0) || undefined }
      : { id: t.key, kind: "read", status, label: t.url ?? t.label ?? "", url: t.url ?? t.label, domain: domainOf(t.url ?? t.label ?? "") };
    const last = out[out.length - 1];
    if (last && last.kind === "research") last.steps.push(step);
    else out.push({ kind: "research", key: `research-${t.key}`, steps: [step] });
  }
  return out;
}

/** "Changes +52 −3" at the top of the stream; opens the Changes tab. */
export function ChangesPill({ events }: { events: AgentEvent[] }) {
  const totals = changeTotals(events);
  if (totals.files === 0) return null;
  return (
    <button
      type="button"
      className="changes-pill"
      data-testid="changes-pill"
      title={`${totals.files} file${totals.files === 1 ? "" : "s"} changed — open Changes`}
      onClick={() => openArtifactInContext({ tab: "changes" })}
    >
      <span>Changes</span>
      <span className="changes-pill__add">+{totals.additions}</span>
      <span className="changes-pill__del">−{totals.deletions}</span>
    </button>
  );
}

export function AgentActivityList({
  events,
  status,
  onApprove,
}: {
  events: AgentEvent[];
  status: string;
  onApprove: (callId: string, approved: boolean, scope?: "once" | "mission", secrets?: Record<string, string>) => void;
}) {
  // RAW EVENTS → presentation items → rows. Raw event names, timestamps,
  // task/mission/agent internals and reviewer text never render directly;
  // tool lifecycles collapse into single rows that update in place.
  const items = React.useMemo(() => groupToolRuns(groupResearch(reducePresentation(events, status))), [events, status]);
  const live = status === "running" || status === "awaiting_approval" || status === "verifying";
  const toolLive = items.some((item) => (item.kind === "tool" && item.status === "running") || (item.kind === "workgroup" && item.status === "running") || (item.kind === "research" && item.steps.some((st) => st.status === "running")));

  const liveStatus = [...items].reverse().find((item) => item.kind === "status" && (item.ephemeral || (item.thought && !item.thought.endTs && (status === "running" || status === "awaiting_approval"))));
  const liveLabel = liveStatus && liveStatus.kind === "status" ? liveStatus.label : "";
  const motion = status === "awaiting_approval" ? "waiting" : toolLive || orbMotionForLabel(liveLabel) === "tool" ? "tool" : orbMotionForLabel(liveLabel);
  const slotMessage = motion === "thinking" ? ORION_THINKING_TEXT : motion === "tool" && (liveLabel === "Thinking…" || liveLabel === ORION_WORKING_TEXT || liveLabel.length === 0) ? ORION_WORKING_TEXT : liveLabel;

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
          case "research":
            return <ResearchTimeline key={item.key} steps={item.steps} live={live && item.steps.some((st) => st.status === "running")} />;
          case "tool":
            return <ToolActivityRow key={item.key} item={item} />;
          case "toolrun":
            return <ToolRunGroup key={item.key} items={item.items} />;
          case "group":
            return <ToolActivityGroup key={item.key} group={item} />;
          case "workgroup":
            return <WorkGroupRow key={item.key} group={item} />;
          case "status":
            if (item.ephemeral) return null;
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
              if (live) return null;
              if (!dur && !item.thought.summary) return null;
              // "Thought · 5 seconds": a quiet marker. The summary is a safe
              // one-line status label (never private reasoning), shown on hover.
              return (
                <div
                  key={item.key}
                  className="stream-thought"
                  title={item.thought.summary ?? "Thought"}
                >
                  <span aria-hidden="true" className="stream-thought-icon">✦</span>
                  <span className="stream-thought-label">Thought</span>
                  {dur ? <span>· {dur}</span> : null}
                </div>
              );
            }
            if (item.label.startsWith("Preview updated")) {
              // The chat keeps its site: this row reopens the preview any time,
              // even after a restart (the address never changes for this chat).
              const url = item.previewUrl;
              return (
                <button
                  key={item.key}
                  type="button"
                  className="preview-updated preview-updated--link"
                  data-testid="preview-row"
                  disabled={!url}
                  title={url ? "Open this site in Preview" : undefined}
                  onClick={() => url && openArtifactInContext({ tab: "preview", url })}
                >
                  <span aria-hidden="true">↻</span>
                  <span>{item.label}</span>
                  {url && <span className="preview-updated__open">Open preview ↗</span>}
                </button>
              );
            }
            return (
              <div key={item.key} className={`stream-status${item.tone === "rework" ? " is-rework" : ""}`}>
                <span aria-hidden="true" className="stream-status__icon">{item.tone === "rework" ? "↻" : "·"}</span>
                <span>{item.label}</span>
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
      <OrbStatusSlot
        active={live && (Boolean(liveStatus) || toolLive)}
        failed={status === "error" || status === "failed"}
        motion={motion}
        message={slotMessage}
      />
    </>
  );
}

/** What the step will do, in words: "$ npm test", "Write notes.md" — not raw JSON. */
export function approvalSummary(tool: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (/^(terminal|run_command|start_process|run_tests|ssh_exec|remote_exec)$/.test(tool) && str(args.command)) return `$ ${str(args.command)}`.slice(0, 400);
  if (/^(write_file|edit_file|create_file)$/.test(tool) && str(args.path)) return `${tool === "edit_file" ? "Edit" : "Write"} ${str(args.path)}`;
  if (tool === "delete_file" && str(args.path)) return `Delete ${str(args.path)}`;
  if (tool === "move_file") return `Move ${str(args.from)} → ${str(args.to)}`;
  if (/^browser_/.test(tool) && str(args.url)) return `Open ${str(args.url)}`;
  const first = Object.values(args).find((v) => typeof v === "string") as string | undefined;
  return `${tool.replace(/^mcp\./, "").replace(/[._]/g, " ")}${first ? ` ${first}` : ""}`.slice(0, 400);
}

function formatBytes(n?: number): string {
  if (!n || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function ArtifactCard({ item }: { item: AttachmentItem }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!item.artifactId) return null;
  const ext = item.name.split(".").pop()?.toLowerCase() ?? "";
  const isImage = /^(png|jpe?g|webp|gif|svg|avif)$/.test(ext) || (item.mediaType ?? "").startsWith("image/");
  const typeLabel = isImage ? `${ext.replace("jpeg", "jpg").toUpperCase()} Image` : fileTypeLabel(item.name);
  const empty = item.size === 0;
  const projectPath = item.projectPath || (item.path && item.path !== item.name ? item.path : "");
  const meta = [busy ? "Downloading…" : error || (empty ? "Empty file" : typeLabel), formatBytes(item.size)].filter(Boolean).join(" · ");

  function preview() {
    openArtifactInContext({ tab: "preview", artifactId: item.artifactId, path: item.name, fileName: item.name });
  }
  async function download() {
    if (!item.artifactId || busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await fetch(apiUrl(item.downloadPath || `/artifacts/${item.artifactId}/download`), { headers: authHeaders() });
      if (!r.ok) throw new Error("Download failed");
      const blob = await r.blob();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(new Error("Could not read the file"));
        reader.readAsDataURL(blob);
      });
      // Desktop: native Save As with the original bytes and filename.
      // Web (no bridge): the browser's own download.
      const bridge = (window as unknown as { orvyn?: { files?: { saveAs?: (p: { defaultName: string; base64: string }) => Promise<{ ok: boolean; canceled?: boolean; error?: string }> } } }).orvyn?.files;
      if (bridge?.saveAs) {
        const saved = await bridge.saveAs({ defaultName: item.name, base64: dataUrl.slice(dataUrl.indexOf(",") + 1) });
        if (!saved.ok && !saved.canceled) throw new Error(saved.error || "Could not save");
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = item.name;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err: any) {
      setError(String(err?.message ?? "Could not download. Try again."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        ...card("var(--border)"),
        display: "flex",
        alignItems: "center",
        gap: 12,
        width: "min(100%, 440px)",
        textAlign: "left",
        borderRadius: 12,
        padding: "10px 12px",
        color: "var(--text)",
      }}
      data-testid="generated-asset-card"
    >
      <button
        type="button"
        onClick={preview}
        disabled={empty}
        title={empty ? "Empty file" : `Preview ${item.name}`}
        data-testid="generated-asset-thumb"
        style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 0, width: 72, height: 72, flexShrink: 0, overflow: "hidden", cursor: empty ? "not-allowed" : "pointer", background: "var(--bg-app)", display: "flex", alignItems: "center", justifyContent: "center" }}
      >
        {empty ? <IconFile /> : isImage ? <ArtifactThumbnail artifactId={item.artifactId!} name={item.name} /> : <IconFile />}
      </button>
      <span style={{ minWidth: 0, flex: 1 }}>
        <span style={{ display: "block", fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
        <span style={{ display: "block", fontSize: 12, color: error ? "var(--danger, #F25F75)" : "var(--text-muted)" }}>{meta}</span>
        <span style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {projectPath || (item.kindLabel === "generated" ? "Generated asset" : "Files → Generated")}
        </span>
        <span style={{ display: "flex", gap: 8, marginTop: 6 }}>
          <button type="button" onClick={preview} disabled={empty} data-testid="generated-asset-preview" style={btn("var(--accent)")}>
            Preview
          </button>
          <button type="button" onClick={() => void download()} disabled={busy || empty} data-testid="generated-asset-download" style={btn("transparent")}>
            ↓ Download
          </button>
        </span>
      </span>
    </div>
  );
}

/** The actual image, fetched with auth and shown at thumbnail size. */
function ArtifactThumbnail({ artifactId, name }: { artifactId: string; name: string }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setDataUrl(null);
    fetch(apiUrl(`/files/read?id=${encodeURIComponent(artifactId)}`), { headers: authHeaders(), signal: controller.signal })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok || typeof d?.dataUrl !== "string") throw new Error("no image");
        if (!controller.signal.aborted) setDataUrl(d.dataUrl);
      })
      .catch(() => { if (!controller.signal.aborted) setDataUrl(null); });
    return () => controller.abort();
  }, [artifactId]);
  return dataUrl ? <img src={dataUrl} alt={name} style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : <IconFile />;
}

export function CapabilityCard({ item, install, onInstalled }: {
  item: CapabilityRequiredItem;
  /** Chat: the server ORION found; the button installs it and the reply continues. */
  install?: { name: string; canonicalId: string; description?: string; secrets?: string[]; freeInstall?: boolean };
  onInstalled?: () => void;
}) {
  const [settled, setSettled] = useState(Boolean(item.settled));
  const [state, setState] = useState<"idle" | "installing" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  if (install) {
    const need = install.secrets ?? [];
    const run = async () => {
      setState("installing"); setError("");
      try {
        const res = await fetch(apiUrl("/mcp/capability/install"), {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ canonicalId: install.canonicalId, ...(need.length ? { secrets } : {}) }),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok || !out.ok) throw new Error(out.error || `Install failed (${res.status})`);
        setState("done");
        onInstalled?.();
      } catch (err: any) {
        setState("error"); setError(String(err?.message ?? err));
      }
    };
    return (
      <div style={card("var(--accent)")} data-testid="capability-install-card">
        <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 4 }}>
          ORION wants to install {install.name} to {item.query || "continue"}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.45 }}>
          {install.description ? `${install.description.slice(0, 220)} ` : ""}
          {install.freeInstall ? "Official public MCP tool, no API key. " : ""}
          ORVYN installs it on this desktop, connects it and ORION continues.
        </div>
        {state !== "done" && !settled && need.map((n) => (
          <input key={n} type="password" placeholder={`${n} (needed by ${install.name})`} value={secrets[n] ?? ""}
            onChange={(e) => setSecrets({ ...secrets, [n]: e.target.value })}
            style={{ display: "block", width: "100%", boxSizing: "border-box", marginBottom: 6, padding: "5px 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }} />
        ))}
        {error && <div style={{ fontSize: 11.5, color: "var(--danger)", marginBottom: 6 }}>{error}</div>}
        {state === "done" ? (
          <span data-testid="capability-installed" style={{ fontSize: 11.5, color: "var(--success)" }}>Installed {install.name} — ORION is continuing.</span>
        ) : settled ? (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Not installed.</span>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button data-testid="capability-install" disabled={state === "installing" || need.some((n) => !secrets[n]?.trim())} onClick={() => void run()} style={btn("var(--accent)")}>
              {state === "installing" ? "Installing…" : `Install ${install.name}`}
            </button>
            <button onClick={() => setSettled(true)} style={btn("var(--border)")}>Not now</button>
          </div>
        )}
      </div>
    );
  }
  const named = item.recommendedServers[0]?.name || item.recommendedServers[0]?.server;
  const primary = named || "an MCP tool";
  const free = Boolean((item.recommendedServers[0] as { freeInstall?: boolean } | undefined)?.freeInstall) || /no API key/i.test(item.reason);
  const openMarket = (query: string) => {
    document.dispatchEvent(new CustomEvent("orvyn:capability-install", { detail: { query, reason: item.reason } }));
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
          <button data-testid="capability-install" onClick={() => openMarket(named || item.query || "")} style={btn("var(--accent)")}>
            {!named ? "Find a tool" : free ? `Install ${primary}` : `Connect ${primary}`}
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
  onApprove: (callId: string, approved: boolean, scope?: "once" | "mission", secrets?: Record<string, string>) => void | Promise<void>;
}) {
  const preview = item.preview as EditPreview | undefined;
  // PENDING → APPROVING → APPROVED/DENIED; a failed request re-enables the
  // buttons (the run-level error surfaces separately) — never a silent click.
  const [busy, setBusy] = useState(false);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const act = (approved: boolean, scope?: "once" | "mission") => {
    setBusy(true);
    const filled = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
    Promise.resolve(onApprove(item.key, approved, scope, approved && Object.keys(filled).length ? filled : undefined)).finally(() => setBusy(false));
  };
  // Answered: one quiet line ("Approved  $ npm test"); the step's own row follows.
  if (item.settled && !item.install) {
    return (
      <div className="stream-status" data-testid="approval-settled" title={approvalSummary(item.tool, item.input)}>
        <span aria-hidden="true" className="stream-status__icon" style={{ color: item.approved ? "var(--success)" : "var(--danger)" }}>{item.approved ? "✓" : "✕"}</span>
        <span>{item.approved ? "Approved" : "Denied"}</span>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{approvalSummary(item.tool, item.input)}</code>
      </div>
    );
  }
  if (item.install) {
    const need = item.install.secrets ?? [];
    const missing = need.some((n) => !secrets[n]?.trim());
    return (
      <div style={card("var(--accent)")} data-testid="install-approval">
        <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 4 }}>
          ORION wants to install {item.install.name}{item.install.query ? ` to ${item.install.query}` : ""}
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 8, lineHeight: 1.45 }}>
          {item.install.description ? `${item.install.description.slice(0, 220)} ` : ""}
          {item.install.freeInstall ? "Official public MCP tool, no API key. " : ""}
          ORVYN installs it on this desktop, connects it and continues the task.
        </div>
        {!item.settled && need.map((n) => (
          <input
            key={n}
            type="password"
            placeholder={`${n} (needed by ${item.install!.name})`}
            value={secrets[n] ?? ""}
            onChange={(e) => setSecrets({ ...secrets, [n]: e.target.value })}
            style={{ display: "block", width: "100%", boxSizing: "border-box", marginBottom: 6, padding: "5px 8px", fontSize: 12, borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", color: "var(--text)" }}
          />
        ))}
        {item.settled ? (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{item.approved ? "Approved — installing" : "Not installed"}</span>
        ) : (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button data-testid="install-approve" disabled={busy || missing} onClick={() => act(true)} style={btn("var(--accent)")}>
              {busy ? "Installing…" : `Install ${item.install.name}`}
            </button>
            <button disabled={busy} onClick={() => act(false)} style={btn("var(--border)")}>Not now</button>
          </div>
        )}
      </div>
    );
  }
  return (
    <div style={card(item.destructive ? "var(--danger)" : "var(--accent)")}>
      <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 6 }}>
        {item.destructive ? "Destructive action requested" : "Agent wants to run"}
        {item.risk && (
          <span
            data-testid="approval-risk"
            title={item.risk === "dangerous" ? "Can destroy data or cut off the server. Always asks, in every access mode." : item.risk === "change" ? "Changes something (restart, install, config edit). Follows your access mode." : "Only reads."}
            style={{ marginLeft: 8, fontSize: 10.5, padding: "1px 6px", borderRadius: 4, border: `1px solid ${item.risk === "dangerous" ? "var(--danger)" : "var(--border)"}`, color: item.risk === "dangerous" ? "var(--danger)" : "var(--text-muted)" }}
          >
            {item.risk === "dangerous" ? "Dangerous" : item.risk === "change" ? "Makes a change" : "Read-only"}
          </span>
        )}
      </div>
      {preview ? (
        <div style={{ marginBottom: 8 }}>
          <DiffPreview preview={preview} collapsible={false} />
        </div>
      ) : (
        <code style={{ ...mono(), display: "block", marginBottom: 8, whiteSpace: "pre-wrap" }}>
          {approvalSummary(item.tool, item.input)}
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
  onRegenerate,
}: {
  events: AgentEvent[];
  runId: string | null;
  finished: boolean;
  /** Called after a successful undo so the parent can refresh open files. */
  onAfterUndo?: () => void;
  /** Answer the same instruction again (a new run in the same conversation). */
  onRegenerate?: () => void;
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
      <SourcesBar events={events} />
      <AnswerActions
        speakKey={`run:${runId ?? ""}`}
        text={finalAnswerText(events)}
        question={String(events.find((e) => e.type === "run.started")?.data.instruction ?? "")}
        sources={collectSources(events)}
        onRegenerate={onRegenerate}
        showCopy={false}
        when={endEvent?.timestamp}
      />
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
