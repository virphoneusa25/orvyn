// apps/desktop/src/renderer/components/BottomWorkPanel.tsx
//
// The approved mockup's bottom work panel: the tab bar Terminal / Logs /
// Build Output / Agent Activity / Problems with Terminal as the default tab.
//
// Honesty contract: only Agent Activity has a live backend today. The other
// tabs open to a truthful "not implemented" pane that names the missing
// dependency — they exist because the target composition shows them, and a
// truthful empty pane is not a fake terminal.

import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

type WorkTab = "terminal" | "logs" | "build" | "activity" | "problems";

const TABS: { id: WorkTab; label: string }[] = [
  { id: "terminal", label: "Terminal" },
  { id: "logs", label: "Logs" },
  { id: "build", label: "Build Output" },
  { id: "activity", label: "Agent Activity" },
  { id: "problems", label: "Problems" },
];

interface RunSummary {
  id: string;
  status: string;
}

interface FeedEvent {
  id: string;
  sequence: number;
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

function describe(e: FeedEvent): string | null {
  const d = e.data as any;
  switch (e.type) {
    case "run.started":
      return `run started (${d.mode ?? "agent"}): ${String(d.instruction ?? "").slice(0, 120)}`;
    case "mission.created":
      return `mission ${d.missionId}: ${String(d.goal ?? "").slice(0, 120)}`;
    case "task.created":
      return `task ${d.taskId} → ${d.agent}: ${String(d.description ?? "").slice(0, 120)}`;
    case "agent.started":
      return `${d.agent} started ${d.taskId} on ${d.model}`;
    case "agent.completed":
      return `${d.agent} ${d.ok ? "completed" : "failed"} ${d.taskId}`;
    case "tool.started":
      return `tool ${d.tool}${d.taskId ? ` (${d.taskId})` : ""}`;
    case "tool.completed":
      return `tool ${d.tool} ok${d.preview ? ` — ${String(d.preview).split("\n")[0].slice(0, 90)}` : ""}`;
    case "tool.failed":
      return `tool ${d.tool} FAILED — ${String(d.error ?? "").slice(0, 120)}`;
    case "approval.required":
      return `approval required: ${d.tool}`;
    case "approval.resolved":
      return `approval ${d.approved ? "granted" : "denied"}`;
    case "review.started":
      return d.scope === "mission" ? "final mission review started" : `review started (${d.taskId ?? "task"})`;
    case "review.passed":
      return `review passed${d.taskId ? ` (${d.taskId})` : ""}`;
    case "review.rejected":
      return `review rejected${d.cycle ? ` (cycle ${d.cycle})` : ""}${d.notes ? ` — ${String(d.notes).slice(0, 100)}` : ""}`;
    case "review.approved":
      return `mission approved — score ${d.score}`;
    case "mission.blocked":
      return "mission BLOCKED — human decision required";
    case "test.started":
      return `verification started: ${d.kind}`;
    case "test.completed":
      return `verification ${d.ok ? "passed" : "failed"}: ${d.kind}`;
    case "sandbox.started":
      return `sandbox container started (${d.container ?? ""})`;
    case "sandbox.stopped":
      return `sandbox stopped — ${d.mergedFiles} file(s) merged back`;
    case "checkpoint.created":
      return `checkpoint ${d.checkpointId ?? d.id} created`;
    case "checkpoint.restored":
      return "checkpoint restored";
    case "run.completed":
      return "run completed";
    case "run.cancelled":
      return "run stopped by user";
    case "run.error":
      return `run error: ${String(d.message ?? "").slice(0, 140)}`;
    default:
      return null;
  }
}

export function BottomWorkPanel({ height = 176 }: { height?: number }) {
  // The approved Home shows the utility drawer COLLAPSED by default — a slim
  // tab rail, never a giant empty terminal. Expanding is a click; a drag
  // handle resizes; the choice persists for the session.
  const [expanded, setExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(height);
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);
  // Terminal is the default tab, matching the approved composition.
  const [tab, setTab] = useState<WorkTab>("terminal");
  const [run, setRun] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const term = useTerminalSession();

  useEffect(() => {
    let stop = false;
    async function refresh() {
      try {
        const list = await fetch(apiUrl("/agent/stream/runs"), { headers: authHeaders() }).then((r) => r.json());
        if (stop) return;
        const latest: RunSummary | undefined = (list.runs ?? [])[0];
        setRun(latest ?? null);
        if (latest) {
          const ev = await fetch(apiUrl(`/agent/stream/runs/${latest.id}/events.json?after=0`), {
            headers: authHeaders(),
          }).then((r) => r.json());
          if (!stop) setEvents(ev.events ?? []);
        } else {
          setEvents([]);
        }
      } catch {
        // Backend down — keep the previous view.
      }
    }
    void refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const lines = events.map((e) => ({ e, text: describe(e) })).filter((x) => x.text);
  const problemCount = lines.filter((l) => /FAILED|error|blocked/i.test(l.text ?? "")).length;

  useEffect(() => {
    if (tab === "activity") scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events.length, tab]);

  return (
    <div
      style={{
        height: expanded ? drawerHeight : 30,
        flexShrink: 0,
        background: "var(--orvyn-surface-1)",
        borderTop: "1px solid var(--orvyn-border-soft)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        overflow: "hidden",
      }}
    >
      {/* Drag handle — only meaningful while expanded. */}
      {expanded && (
        <div
          onPointerDown={(e) => {
            dragRef.current = { startY: e.clientY, startH: drawerHeight };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (!dragRef.current) return;
            const delta = dragRef.current.startY - e.clientY;
            setDrawerHeight(Math.max(120, Math.min(520, dragRef.current.startH + delta)));
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          title="Drag to resize"
          style={{ height: 4, cursor: "ns-resize", flexShrink: 0, background: "transparent" }}
        />
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", alignItems: "center", height: 26, flexShrink: 0, padding: "0 6px" }}>
        {TABS.map((t) => {
          const active = expanded && tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setExpanded(true);
              }}
              style={{
                background: "transparent",
                border: "none",
                borderBottom: active ? "2px solid var(--orvyn-purple)" : "2px solid transparent",
                color: active ? "var(--orvyn-text)" : "var(--orvyn-text-muted)",
                fontSize: 10.5,
                fontWeight: 600,
                padding: "0 11px",
                height: "100%",
                cursor: "pointer",
              }}
            >
              {t.label}
              {t.id === "problems" && problemCount > 0 && (
                <span style={{ marginLeft: 6, color: "var(--orvyn-red)", fontSize: 9.5 }}>{problemCount}</span>
              )}
            </button>
          );
        })}
        <span style={{ marginLeft: "auto", paddingRight: 8, fontSize: 10, color: "var(--orvyn-text-muted)", display: "inline-flex", gap: 12, alignItems: "center" }}>
          {run ? `latest run: ${run.status}` : ""}
          {!expanded && (
            <button
              onClick={() => {
                setTab("terminal");
                setExpanded(true);
              }}
              title="Open a real PowerShell session"
              style={{
                background: "transparent",
                border: "1px solid var(--orvyn-border)",
                borderRadius: 5,
                color: "var(--orvyn-purple-hi)",
                fontSize: 10,
                padding: "2px 10px",
                cursor: "pointer",
              }}
            >
              Open Terminal
            </button>
          )}
          <button
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Collapse" : "Expand"}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--orvyn-text-muted)",
              cursor: "pointer",
              fontSize: 9,
              padding: "2px 4px",
            }}
          >
            {expanded ? "▾" : "▴"}
          </button>
        </span>
      </div>

      {/* Content — only while expanded; collapsed is the slim rail. */}
      {expanded && (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        {tab === "terminal" ? (
          <TerminalView term={term} />
        ) : tab === "activity" ? (
          <div
            ref={scroller}
            style={{
              flex: 1,
              overflowY: "auto",
              padding: "4px 12px 8px",
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              lineHeight: 1.65,
              color: "var(--text-secondary)",
            }}
          >
            {lines.length === 0 ? (
              <div style={{ color: "var(--orvyn-text-muted)" }}>
                No agent activity yet — runs, tool calls, reviews and mission events stream here in real time.
              </div>
            ) : (
              lines.map(({ e, text }) => (
                <div key={e.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                  <span style={{ color: "var(--orvyn-text-muted)" }}>
                    {new Date(e.timestamp).toLocaleTimeString([], { hour12: false })}{" "}
                  </span>
                  <span
                    style={{
                      color:
                        e.type.includes("failed") || e.type.includes("error") || e.type === "mission.blocked"
                          ? "var(--orvyn-red)"
                          : undefined,
                    }}
                  >
                    {text}
                  </span>
                </div>
              ))
            )}
          </div>
        ) : (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              color: "var(--orvyn-text-muted)",
            }}
          >
            {tab === "logs" && "Service logs arrive with the observability pipeline (structured logging phase)."}
            {tab === "build" && "Build output appears here when the agent runs build commands — see Agent Activity."}
            {tab === "problems" && (problemCount > 0 ? `${problemCount} issue(s) in the latest run — see Agent Activity.` : "No problems detected in the latest run.")}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

// ── Real terminal session ────────────────────────────────────────────────
// A real PowerShell through main-process pipes: start on demand, stream
// output, write lines. Full interactive TUI apps need node-pty — documented
// upgrade path, not hidden.

/** Removes ANSI control sequences (colors, cursor movement) for text display. */
function stripAnsi(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  const ANSI = /\u001B\[[0-9;?]*[A-Za-z]/g;
  return chunk
    .replace(ANSI, "")
    .replace(/\u001B\][^\u0007]*\u0007/g, "") // OSC (window title etc.)
    .replace(/\u001B[()][0-9A-B]/g, "") // charset selects
    .replace(/\r(?!\n)/g, "");
}

export interface TerminalState {
  sessionId: string | null;
  output: string;
  busy: boolean;
  start: () => Promise<void>;
  sendLine: (line: string) => Promise<void>;
  kill: () => Promise<void>;
}

export function useTerminalSession(): TerminalState {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = window.orvyn.terminal.onData((e) => {
      // Shells emit ANSI control sequences; a text view must not show them
      // as garbage — translate colors/cursor codes away, keep clean lines.
      setOutput((prev) => (prev + stripAnsi(e.data)).slice(-16000));
    });
    return () => {
      off();
    };
  }, []);

  return {
    sessionId,
    output,
    busy,
    start: async () => {
      if (sessionId || busy) return;
      setBusy(true);
      try {
        const id = await window.orvyn.terminal.start();
        setSessionId(id);
      } finally {
        setBusy(false);
      }
    },
    sendLine: async (line: string) => {
      if (!sessionId) return;
      await window.orvyn.terminal.write(sessionId, line + "\r\n");
    },
    kill: async () => {
      if (!sessionId) return;
      await window.orvyn.terminal.kill(sessionId);
      setSessionId(null);
      setOutput("");
    },
  };
}

export function TerminalView({ term }: { term: TerminalState }) {
  const [input, setInput] = useState("");
  const outRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [term.output]);

  if (!term.sessionId) {
    return (
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          padding: 12,
        }}
      >
        <button
          onClick={() => void term.start()}
          disabled={term.busy}
          style={{
            background: "var(--orvyn-purple)",
            border: "none",
            borderRadius: 6,
            color: "#fff",
            fontSize: 12,
            padding: "6px 18px",
            cursor: "pointer",
          }}
        >
          {term.busy ? "Starting…" : "Start PowerShell"}
        </button>
        <span style={{ fontSize: 10.5, color: "var(--orvyn-text-muted)" }}>
          A real shell through the Electron main process — commands execute on this machine.
        </span>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div
        ref={outRef}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: "auto",
          padding: "4px 12px",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          lineHeight: 1.55,
          color: "var(--text-secondary)",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {term.output}
      </div>
      <div style={{ display: "flex", gap: 8, padding: "4px 12px 8px", flexShrink: 0 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) {
              void term.sendLine(input);
              setInput("");
            }
          }}
          placeholder="type a command and press Enter…"
          style={{
            flex: 1,
            background: "var(--orvyn-bg)",
            border: "1px solid var(--orvyn-border-soft)",
            borderRadius: 6,
            color: "var(--orvyn-text)",
            fontFamily: "var(--font-mono)",
            fontSize: 11,
            padding: "4px 8px",
            outline: "none",
          }}
        />
        <button
          onClick={() => void term.kill()}
          title="Close shell"
          style={{
            background: "transparent",
            border: "1px solid var(--orvyn-border)",
            borderRadius: 6,
            color: "var(--orvyn-text-muted)",
            fontSize: 10.5,
            padding: "3px 9px",
            cursor: "pointer",
          }}
        >
          Close
        </button>
      </div>
    </div>
  );
}
