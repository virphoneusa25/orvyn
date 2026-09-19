// apps/desktop/src/renderer/components/ReportsPanel.tsx
//
// The "Reports" nav view: what the system actually did — token spend, quota,
// queue pressure, recent runs with their outcomes, and mission history. Every
// number comes from live backend endpoints; nothing here is decorative.
import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { IconReport } from "./Icons";

interface UsagePayload {
  totals: { requests: number; promptTokens: number; completionTokens: number };
  quota: Record<string, unknown>;
  queue: { running: number; waiting: number; concurrency: number };
  events: { model: string; kind: string; promptTokens?: number; completionTokens?: number; at?: string }[];
}

interface RunRow {
  id: string;
  status: string;
  createdAt: number;
  projectRoot: string;
  eventCount: number;
  usage?: { promptTokens: number; completionTokens: number; turns: number };
}

interface MissionRow {
  id: string;
  goal: string;
  status: string;
  createdAt: string;
  tasks?: { status: string }[];
}

const STATUS_COLOR: Record<string, string> = {
  completed: "var(--success)",
  error: "var(--danger)",
  cancelled: "var(--warning)",
  running: "var(--accent)",
  awaiting_approval: "var(--warning)",
  COMPLETED: "var(--success)",
  BLOCKED: "var(--warning)",
  FAILED: "var(--danger)",
  PLANNING: "var(--accent)",
};

export function ReportsPanel() {
  const [usage, setUsage] = useState<UsagePayload | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const headers = authHeaders();
        const [u, r, m] = await Promise.all([
          fetch(apiUrl("/usage?limit=50"), { headers }).then((x) => x.json()),
          fetch(apiUrl("/agent/stream/runs"), { headers }).then((x) => x.json()),
          fetch(apiUrl("/missions"), { headers }).then((x) => x.json()),
        ]);
        if (!alive) return;
        setUsage(u);
        setRuns(r.runs ?? []);
        setMissions((m.missions ?? []).slice(0, 10));
        setError(null);
      } catch (err: any) {
        if (alive) setError(err.message);
      }
    }
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16, minWidth: 0 }}>
      <div style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
        <IconReport size={15} /> Reports
      </div>

      {error && (
        <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10 }}>
          Could not reach the backend: {error}
        </div>
      )}

      {usage && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, marginBottom: 18 }}>
          <Tile label="Requests" value={usage.totals.requests.toLocaleString()} />
          <Tile label="Prompt tokens" value={usage.totals.promptTokens.toLocaleString()} />
          <Tile label="Completion tokens" value={usage.totals.completionTokens.toLocaleString()} />
          <Tile
            label="Mission queue"
            value={`${usage.queue.running} running / ${usage.queue.waiting} waiting`}
          />
        </div>
      )}

      <Section title="Recent runs">
        {runs.length === 0 && <Empty>No runs yet in this backend session.</Empty>}
        {runs.slice(0, 12).map((r) => (
          <div key={r.id} style={rowStyle()}>
            <span style={{ color: STATUS_COLOR[r.status] ?? "var(--text-muted)", fontSize: 11.5, minWidth: 92 }}>
              ● {r.status.replace("_", " ")}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-secondary)" }}>
              {r.projectRoot ? r.projectRoot.split(/[\\/]/).pop() : "—"}
              {r.usage ? ` · ${r.usage.turns} turns` : ""}
              {r.usage ? ` · ${(r.usage.promptTokens + r.usage.completionTokens).toLocaleString()} tok` : ""}
            </span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
              {new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </Section>

      <Section title="Missions">
        {missions.length === 0 && <Empty>No missions yet.</Empty>}
        {missions.map((m) => (
          <div key={m.id} style={rowStyle()}>
            <span style={{ color: STATUS_COLOR[m.status] ?? "var(--text-muted)", fontSize: 11.5, minWidth: 92 }}>
              ● {m.status}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--text-secondary)" }}>
              {m.goal}
            </span>
            {m.tasks && (
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                {m.tasks.filter((t) => t.status === "COMPLETED").length}/{m.tasks.length} tasks
              </span>
            )}
          </div>
        ))}
      </Section>

      {usage && usage.events.length > 0 && (
        <Section title="Model activity (latest first)">
          {usage.events.slice(0, 15).map((e, i) => (
            <div key={i} style={{ ...rowStyle(), gridTemplateColumns: "none", display: "flex", gap: 10 }}>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", minWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {e.model}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{e.kind}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
                {(e.promptTokens ?? 0) + (e.completionTokens ?? 0)} tok
              </span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 10, background: "var(--bg-elevated)" }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--text-muted)", padding: "4px 0 8px" }}>{children}</div>;
}

function rowStyle(): React.CSSProperties {
  return {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 8px",
    borderBottom: "1px solid var(--border)",
  };
}
