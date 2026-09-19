// apps/desktop/src/renderer/components/BottomPanel.tsx
//
// Bottom dock. Today it carries one real tab — Agent Activity, a live feed of
// the latest run's events. Terminal/Problems/Tests tabs are NOT rendered until
// their backends exist (no placeholder tabs, per the no-fake-buttons rule).

import React, { useEffect, useRef, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface RunSummary {
  id: string;
  status: string;
  createdAt: number;
  eventCount: number;
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
    case "checkpoint.created":
      return `checkpoint ${d.checkpointId} created`;
    case "checkpoint.restored":
      return `checkpoint ${d.checkpointId} restored`;
    case "run.completed":
      return "run completed";
    case "run.error":
      return `run error: ${String(d.message ?? "").slice(0, 140)}`;
    default:
      return null; // message deltas etc. belong to the chat panes, not the activity log
  }
}

export function BottomPanel() {
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const scroller = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
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
        // Backend down — leave the previous view.
      }
    }
    void refresh();
    const t = setInterval(refresh, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [open]);

  useEffect(() => {
    if (open) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events.length, open]);

  const lines = events.map((e) => ({ e, text: describe(e) })).filter((x) => x.text);

  return (
    <div style={{ borderTop: "1px solid var(--border)", background: "var(--bg-panel)", flexShrink: 0 }}>
      <div style={{ display: "flex", alignItems: "center", height: 28 }}>
        <button
          onClick={() => setOpen((o) => !o)}
          style={{
            background: "transparent",
            border: "none",
            borderBottom: open ? "2px solid var(--accent)" : "2px solid transparent",
            color: open ? "var(--text)" : "var(--text-secondary)",
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.4,
            padding: "0 12px",
            height: "100%",
            cursor: "pointer",
          }}
        >
          AGENT ACTIVITY
        </button>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {run ? `latest run ${run.status}` : "no runs yet"}
        </span>
        <span style={{ marginLeft: "auto", paddingRight: 10, fontSize: 10, color: "var(--text-muted)" }}>
          {open ? "click tab to collapse" : ""}
        </span>
      </div>
      {open && (
        <div
          ref={scroller}
          style={{
            height: 160,
            overflowY: "auto",
            padding: "6px 12px 10px",
            fontFamily: "JetBrains Mono, Consolas, monospace",
            fontSize: 11.5,
            lineHeight: 1.7,
            color: "var(--text-secondary)",
          }}
        >
          {lines.length === 0 ? (
            <div style={{ color: "var(--text-muted)" }}>
              No agent activity yet. Start a run from the Build tab and its tool calls, reviews, and mission events
              stream here.
            </div>
          ) : (
            lines.map(({ e, text }) => (
              <div key={e.id} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                <span style={{ color: "var(--text-muted)" }}>
                  {new Date(e.timestamp).toLocaleTimeString()}{" "}
                </span>
                <span style={{ color: e.type.includes("failed") || e.type.includes("error") || e.type === "mission.blocked" ? "#e06c75" : undefined }}>
                  {text}
                </span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
