import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

type Tab = "overview" | "experiences" | "skills" | "datasets" | "evaluations" | "models" | "failures";

interface Overview {
  experiencesCollected: number;
  successfulRuns: number;
  trainingCandidates: number;
  validatedSkills: number;
  skillCandidates: number;
  failureClusters: { category: string; count: number }[];
  currentCandidateModel: { version?: string; status?: string } | null;
}

export function LearningCenter() {
  const [tab, setTab] = useState<Tab>("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [rows, setRows] = useState<unknown[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [optOut, setOptOut] = useState(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const headers = authHeaders();
        const [o, extra] = await Promise.all([
          fetch(apiUrl("/learning"), { headers }).then((r) => r.json()),
          tab === "overview"
            ? Promise.resolve({ items: [] })
            : fetch(apiUrl(pathFor(tab)), { headers }).then((r) => r.json()),
        ]);
        if (!alive) return;
        setOverview(o.overview);
        setOptOut(Boolean(o.trainingOptOut));
        setRows(listFrom(tab, extra));
        setError(null);
      } catch (err: any) {
        if (alive) setError(err.message);
      }
    }
    void load();
    const timer = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tab]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--orvyn-surface-1)" }}>
      <div style={{ padding: "18px 20px 10px", borderBottom: "1px solid var(--orvyn-border-soft)" }}>
        <div style={{ fontSize: 18, fontWeight: 700 }}>Learning</div>
        <div style={{ fontSize: 12, color: "var(--orvyn-text-muted)", marginTop: 3 }}>
          Experiences, evaluations, skill candidates, and dataset preparation. Production models are never auto-trained or auto-promoted.
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 14, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={pill(tab === t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
        {error && (
          <div style={{ padding: 12, border: "1px solid var(--orvyn-border)", borderRadius: 8, color: "var(--orvyn-text-muted)" }}>
            Learning API unavailable: {error}
          </div>
        )}
        {tab === "overview" && overview && (
          <>
            {optOut && <div style={card}>Training opt-out is on. New experiences are not captured.</div>}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
              <Stat label="Experiences" value={overview.experiencesCollected} />
              <Stat label="Successful runs" value={overview.successfulRuns} />
              <Stat label="Skill candidates" value={overview.skillCandidates} />
              <Stat label="Validated skills" value={overview.validatedSkills} />
              <Stat label="Training datasets" value={overview.trainingCandidates} />
              <Stat label="Candidate model" value={overview.currentCandidateModel?.version ?? "none"} />
            </div>
            <div style={{ marginTop: 18, fontSize: 12, color: "var(--orvyn-text-muted)" }}>
              Failure clusters
            </div>
            {overview.failureClusters.length === 0 ? (
              <Empty text="No repeated failure patterns yet." />
            ) : (
              overview.failureClusters.map((c) => (
                <div key={c.category} style={card}>
                  <b>{c.category}</b>
                  <span style={{ marginLeft: 8, fontSize: 12, color: "var(--orvyn-text-muted)" }}>{c.count}</span>
                </div>
              ))
            )}
          </>
        )}
        {tab !== "overview" && rows.length === 0 && !error && <Empty text={emptyFor(tab)} />}
        {tab !== "overview" &&
          rows.map((row, i) => (
            <pre key={i} style={card}>
              {JSON.stringify(row, null, 2)}
            </pre>
          ))}
      </div>
    </div>
  );
}

const TABS: { id: Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "experiences", label: "Experiences" },
  { id: "skills", label: "Skills" },
  { id: "datasets", label: "Datasets" },
  { id: "evaluations", label: "Evaluations" },
  { id: "models", label: "Model Training" },
  { id: "failures", label: "Failure Patterns" },
];

function pathFor(tab: Tab): string {
  if (tab === "experiences") return "/learning/experiences";
  if (tab === "skills") return "/learning/skills";
  if (tab === "datasets") return "/learning/datasets";
  if (tab === "evaluations") return "/learning/evaluations";
  if (tab === "models") return "/learning/models";
  return "/learning/failures";
}

function listFrom(tab: Tab, extra: any): unknown[] {
  if (tab === "experiences") return extra.experiences ?? [];
  if (tab === "skills") return extra.skills ?? [];
  if (tab === "datasets") return extra.datasets ?? [];
  if (tab === "evaluations") return extra.evaluations ?? [];
  if (tab === "models") return extra.models ?? [];
  return extra.clusters ?? [];
}

function emptyFor(tab: Tab): string {
  if (tab === "experiences") return "No completed runs have been captured yet.";
  if (tab === "skills") return "Skill candidates appear after at least two successful similar runs. They stay unvalidated until reviewed.";
  if (tab === "datasets") return "Training datasets are built only from sanitized successful runs.";
  if (tab === "evaluations") return "Run evaluations appear after a mission settles.";
  if (tab === "models") return "No candidate models. Fine-tunes are never auto-promoted to production.";
  return "No clustered failures yet.";
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={card}>
      <div style={{ fontSize: 11, color: "var(--orvyn-text-muted)" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={{ padding: "36px 12px", textAlign: "center", color: "var(--orvyn-text-muted)", fontSize: 12 }}>{text}</div>;
}

const card: React.CSSProperties = {
  padding: "12px 14px",
  border: "1px solid var(--orvyn-border-soft)",
  borderRadius: 8,
  background: "var(--orvyn-surface-2)",
  marginBottom: 8,
  fontSize: 12,
  whiteSpace: "pre-wrap",
  overflow: "auto",
};

function pill(active: boolean): React.CSSProperties {
  return {
    background: active ? "var(--orvyn-purple)" : "transparent",
    border: "1px solid var(--orvyn-border)",
    borderRadius: 999,
    color: active ? "#fff" : "var(--orvyn-text-secondary)",
    padding: "5px 10px",
    fontSize: 11,
    cursor: "pointer",
  };
}
