// apps/desktop/src/renderer/components/ReviewPanel.tsx
//
// The Review tab: the Review Engine's verdicts for the most recent mission —
// blocking issues, warnings, required changes, and the per-task review notes.
// Reads only live mission/run data; shows an honest empty state otherwise.

import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface MissionTask {
  id: string;
  description: string;
  agent: string;
  status: string;
  reviewNotes?: string;
}

interface MissionView {
  id: string;
  runId: string;
  goal: string;
  status: string;
  reviewCycles: number;
  createdAt: number;
  tasks: MissionTask[];
}

interface ReviewEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export function ReviewPanel({runId}: {runId?: string} = {}) {
  const [mission, setMission] = useState<MissionView | null>(null);
  const [reviews, setReviews] = useState<ReviewEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function refresh() {
      try {
        const m = await fetch(apiUrl("/missions"), { headers: authHeaders() }).then((r) => r.json());
        if (stop) return;
        const latest: MissionView | undefined = runId ? (m.missions ?? []).find((item: MissionView) => item.runId === runId) : (m.missions ?? [])[0];
        setMission(latest ?? null);
        setError(null);
        if (latest) {
          const ev = await fetch(apiUrl(`/agent/stream/runs/${latest.runId}/events.json?after=0`), {
            headers: authHeaders(),
          }).then((r) => r.json());
          if (stop) return;
          setReviews(
            (ev.events ?? []).filter((e: ReviewEvent) =>
              ["review.started", "review.passed", "review.rejected", "review.approved", "mission.blocked"].includes(e.type)
            )
          );
        } else {
          setReviews([]);
        }
      } catch (err: any) {
        if (!stop) setError(err.message);
      }
    }
    void refresh();
    const t = setInterval(refresh, 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [runId]);

  if (error) {
    return <div style={{ padding: 16, fontSize: 12, color: "#e06c75" }}>Connection interrupted. Retrying… {error}</div>;
  }

  if (!mission) {
    return (
      <div style={{ padding: 16, color: "var(--text-muted)", fontSize: 13, lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>No mission reviews yet</div>
        The current task has no separate review. Its results and checks appear in the conversation.
      </div>
    );
  }

  const missionReviews = reviews.filter((e) => (e.data as any).scope === "mission" || e.type === "review.approved" || e.type === "mission.blocked");

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 14, color: "var(--text)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2 }}>Latest mission</div>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 4 }}>{mission.goal}</div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 14 }}>
        Status: <b style={{ color: mission.status === "COMPLETED" ? "#5fbf77" : mission.status === "BLOCKED" ? "#e06c75" : "var(--text)" }}>{mission.status}</b>
        {" · "}review cycles used: {mission.reviewCycles}
      </div>

      <Section title="Mission verdicts">
        {missionReviews.length === 0 ? (
          <Empty>The final review has not run yet for this mission.</Empty>
        ) : (
          missionReviews.map((e, i) => <VerdictCard key={i} event={e} />)
        )}
      </Section>

      <Section title="Per-task review notes">
        {mission.tasks.filter((t) => t.reviewNotes).length === 0 ? (
          <Empty>No rejected task attempts.</Empty>
        ) : (
          mission.tasks
            .filter((t) => t.reviewNotes)
            .map((t) => (
              <div key={t.id} style={cardStyle()}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                  [{t.status}] ({t.agent}) {t.description}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", whiteSpace: "pre-wrap" }}>{t.reviewNotes}</div>
              </div>
            ))
        )}
      </Section>
    </div>
  );
}

function VerdictCard({ event }: { event: ReviewEvent }) {
  const d = event.data as any;
  if (event.type === "review.approved") {
    return (
      <div style={cardStyle("#5fbf77")}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#5fbf77" }}>APPROVED — score {String(d.score ?? "?")}</div>
      </div>
    );
  }
  if (event.type === "mission.blocked") {
    return (
      <div style={cardStyle("#e06c75")}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#e06c75" }}>BLOCKED</div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{String(d.reason ?? "")}</div>
      </div>
    );
  }
  if (event.type === "review.rejected") {
    const blocking: string[] = Array.isArray(d.blockingIssues) ? d.blockingIssues : [];
    const changes: string[] = Array.isArray(d.requiredChanges) ? d.requiredChanges : [];
    return (
      <div style={cardStyle("#d9a662")}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#d9a662" }}>
          REJECTED{d.cycle ? ` — cycle ${d.cycle}` : ""}{d.willRetry ? " (rework dispatched)" : ""}
        </div>
        {blocking.length > 0 && (
          <List label="Blocking issues" items={blocking} />
        )}
        {changes.length > 0 && <List label="Required changes" items={changes} />}
        {d.notes ? <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{String(d.notes)}</div> : null}
      </div>
    );
  }
  if (event.type === "review.passed") {
    return (
      <div style={cardStyle("#5fbf77")}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#5fbf77" }}>Passed</div>
        {d.notes ? <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{String(d.notes)}</div> : null}
      </div>
    );
  }
  return (
    <div style={cardStyle()}>
      <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Review in progress…</div>
    </div>
  );
}

function List({ label, items }: { label: string; items: string[] }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>{label}</div>
      <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 12, color: "var(--text-secondary)" }}>
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-secondary)", marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: "var(--text-muted)" }}>{children}</div>;
}

function cardStyle(edge?: string): React.CSSProperties {
  return {
    border: "1px solid var(--border)",
    borderLeft: edge ? `3px solid ${edge}` : "1px solid var(--border)",
    borderRadius: 8,
    padding: "8px 10px",
    background: "var(--bg-panel)",
    marginBottom: 8,
  };
}
