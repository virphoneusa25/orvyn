import React, { useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  destructive?: boolean;
}

interface ToolLogEntry {
  tool: string;
  args: unknown;
  result?: string;
  approved?: boolean;
}

interface AgentSession {
  id: string;
  status: "running" | "pending_approval" | "completed" | "error";
  stepCount: number;
  maxSteps: number;
  finalOutput?: string;
  errorMessage?: string;
  pendingToolCall?: ToolCall;
  toolLog: ToolLogEntry[];
}


export function AgentPanel({ projectRoot }: { projectRoot: string | null }) {
  const [instruction, setInstruction] = useState("");
  const [session, setSession] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleStart() {
    if (!projectRoot || !instruction.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl("/agent/runs"), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ projectRoot, instruction }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Agent failed to start");
      setSession(data.session);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleApprove(approved: boolean) {
    if (!session) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/agent/runs/${session.id}/approve`), {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ approved }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approval failed");
      setSession(data.session);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!projectRoot) {
    return <div style={{ padding: 16, color: "#8b93a7", fontSize: 13 }}>Open a project to use Agent mode.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", color: "#c9d1e0" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1c2330", fontSize: 13, fontWeight: 600 }}>Agent</div>

      <div style={{ padding: 12, borderBottom: "1px solid #1c2330" }}>
        <textarea
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="Give the agent a task, e.g. 'Fix the failing build.'"
          rows={2}
          disabled={session?.status === "running" || session?.status === "pending_approval"}
          style={{ width: "100%", background: "#0f1420", border: "1px solid #1c2330", borderRadius: 6, color: "#e6e9f0", padding: 8, fontSize: 13, resize: "vertical" }}
        />
        <button
          onClick={handleStart}
          disabled={loading || !instruction.trim() || session?.status === "pending_approval"}
          style={{ marginTop: 8, background: "#3b5bfd", border: "none", borderRadius: 6, color: "white", padding: "6px 14px", cursor: "pointer", opacity: loading ? 0.6 : 1 }}
        >
          {loading ? "Working…" : "Run Agent"}
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: 12, fontSize: 13 }}>
        {error && (
          <div style={{ background: "#2a1420", border: "1px solid #f0546a", borderRadius: 6, padding: 10, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        {session && (
          <>
            <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 8 }}>
              Step {session.stepCount}/{session.maxSteps} · status: {session.status}
            </div>

            {session.toolLog.map((entry, i) => (
              <div key={i} style={{ marginBottom: 8, padding: 8, borderRadius: 6, background: "#0f1420", fontSize: 12 }}>
                <div style={{ opacity: 0.7 }}>
                  🔧 {entry.tool}({JSON.stringify(entry.args)})
                  {entry.approved === false && <span style={{ color: "#f0546a" }}> — denied</span>}
                </div>
                <div style={{ whiteSpace: "pre-wrap", marginTop: 4 }}>{entry.result}</div>
              </div>
            ))}

            {session.status === "pending_approval" && session.pendingToolCall && (
              <div
                style={{
                  border: `1px solid ${session.pendingToolCall.destructive ? "#f0546a" : "#3b5bfd"}`,
                  background: session.pendingToolCall.destructive ? "#2a1420" : "#0f1420",
                  borderRadius: 8,
                  padding: 12,
                  marginTop: 8,
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4 }}>
                  {session.pendingToolCall.destructive ? "⚠️ Destructive action requested" : "Agent wants to run:"}
                </div>
                <div style={{ fontFamily: "monospace", fontSize: 12, marginBottom: 8 }}>
                  {session.pendingToolCall.name}({JSON.stringify(session.pendingToolCall.arguments, null, 2)})
                </div>
                {session.pendingToolCall.destructive && (
                  <div style={{ fontSize: 12, marginBottom: 8, color: "#f0546a" }}>
                    This may permanently discard changes or delete data.
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => handleApprove(true)} disabled={loading} style={btn("#3b5bfd")}>
                    Allow
                  </button>
                  <button onClick={() => handleApprove(false)} disabled={loading} style={btn("transparent")}>
                    Deny
                  </button>
                </div>
              </div>
            )}

            {session.status === "completed" && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: "#0f2418", border: "1px solid #1f5c3a" }}>
                {session.finalOutput}
              </div>
            )}
            {session.status === "error" && (
              <div style={{ marginTop: 8, padding: 10, borderRadius: 6, background: "#2a1420", border: "1px solid #4a2230" }}>
                {session.errorMessage}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function btn(bg: string): React.CSSProperties {
  return {
    background: bg,
    border: bg === "transparent" ? "1px solid #2a3244" : "none",
    borderRadius: 6,
    color: bg === "transparent" ? "#c9d1e0" : "white",
    padding: "6px 14px",
    cursor: "pointer",
  };
}
