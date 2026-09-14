import React, { useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface DiffLine {
  type: "context" | "add" | "remove";
  content: string;
}

interface ComposerFileChange {
  path: string;
  after: string;
  isNew: boolean;
  diff: DiffLine[];
  additions: number;
  deletions: number;
}

interface ComposerPlan {
  summary: string;
  files: ComposerFileChange[];
  totals: { filesChanged: number; additions: number; deletions: number };
}


function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div style={{ fontFamily: "monospace", fontSize: 12, background: "#0a0d14", borderRadius: 6, padding: 8, maxHeight: 220, overflowY: "auto" }}>
      {diff.map((line, i) => (
        <div
          key={i}
          style={{
            whiteSpace: "pre-wrap",
            color: line.type === "add" ? "#3fd68a" : line.type === "remove" ? "#f0546a" : "#6b7488",
            background: line.type === "add" ? "#0f2418" : line.type === "remove" ? "#2a1420" : "transparent",
          }}
        >
          {line.type === "add" ? "+ " : line.type === "remove" ? "- " : "  "}
          {line.content}
        </div>
      ))}
    </div>
  );
}

export function ComposerPanel({ projectRoot }: { projectRoot: string | null }) {
  const [instruction, setInstruction] = useState("");
  const [plan, setPlan] = useState<ComposerPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<string[] | null>(null);

  async function handlePlan() {
    if (!projectRoot || !instruction.trim()) return;
    setLoading(true);
    setError(null);
    setPlan(null);
    setApplied(null);
    try {
      const res = await fetch(apiUrl("/composer/plan"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot, instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Composer failed");
      setPlan(data.plan);
      setSelected(new Set(data.plan.files.map((f: ComposerFileChange) => f.path)));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApply(paths?: string[]) {
    if (!plan || !projectRoot) return;
    const targetPaths = paths ?? Array.from(selected);
    const files = plan.files.filter((f) => targetPaths.includes(f.path)).map((f) => ({ path: f.path, content: f.after }));
    setApplying(true);
    try {
      const res = await fetch(apiUrl("/composer/apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot, files }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Apply failed");
      setApplied((prev) => [...(prev ?? []), ...data.written]);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setApplying(false);
    }
  }

  function toggle(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (!projectRoot) {
    return <div style={{ padding: 16, color: "#8b93a7", fontSize: 13 }}>Open a project to use Composer.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "#c9d1e0" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1c2330", fontSize: 13, fontWeight: 600 }}>Composer</div>

      <div style={{ padding: 12, borderBottom: "1px solid #1c2330" }}>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Describe the multi-file change, e.g. 'Add JWT authentication to this application.'"
          rows={3}
          style={{ width: "100%", background: "#0f1420", border: "1px solid #1c2330", borderRadius: 6, color: "#e6e9f0", padding: 8, fontSize: 13, resize: "vertical" }}
        />
        <button
          onClick={handlePlan}
          disabled={loading || !instruction.trim()}
          style={{ marginTop: 8, background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "Planning…" : "Plan Change"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12 }}>
        {error && (
          <div style={{ background: "#2a1420", border: "1px solid #f0546a", borderRadius: 6, padding: 10, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {plan && (
          <>
            <div style={{ fontSize: 13, marginBottom: 8 }}>{plan.summary}</div>
            <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 12 }}>
              {plan.totals.filesChanged} files changed · <span style={{ color: "#3fd68a" }}>+{plan.totals.additions}</span> ·{" "}
              <span style={{ color: "#f0546a" }}>-{plan.totals.deletions}</span>
            </div>

            {plan.files.map((f) => (
              <div key={f.path} style={{ marginBottom: 16, border: "1px solid #1c2330", borderRadius: 8, padding: 10 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
                    <input type="checkbox" checked={selected.has(f.path)} onChange={() => toggle(f.path)} />
                    {f.path} {f.isNew && <span style={{ opacity: 0.5 }}>(new)</span>}
                  </label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <span style={{ fontSize: 11, color: "#3fd68a" }}>+{f.additions}</span>
                    <span style={{ fontSize: 11, color: "#f0546a" }}>-{f.deletions}</span>
                    {applied?.includes(f.path) ? (
                      <span style={{ fontSize: 11, color: "#3fd68a" }}>✓ Applied</span>
                    ) : (
                      <button onClick={() => handleApply([f.path])} disabled={applying} style={btnGhost()}>
                        Apply File
                      </button>
                    )}
                  </div>
                </div>
                <DiffView diff={f.diff} />
              </div>
            ))}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => handleApply()}
                disabled={applying || selected.size === 0}
                style={{ background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer", opacity: applying ? 0.6 : 1 }}
              >
                {applying ? "Applying…" : `Apply Selected (${selected.size})`}
              </button>
              <button onClick={() => { setPlan(null); setApplied(null); }} style={btnGhost()}>
                Reject / Clear
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function btnGhost(): React.CSSProperties {
  return { background: "transparent", border: "1px solid #2a3244", borderRadius: 6, color: "#c9d1e0", padding: "4px 10px", fontSize: 12, cursor: "pointer" };
}
