// apps/desktop/src/renderer/components/MissionControl.tsx
//
// Mission Control: the agent roster and every mission's task graph, bound ONLY
// to live backend state (/agents, /missions). Agents whose backend is not
// implemented are shown disabled with the real reason — never as fake buttons.

import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";

interface RosterAgent {
  role: string;
  label: string;
  modelTask: string;
  status: "ready" | "pending";
  pendingReason?: string;
  modelId: string | null;
}

interface MissionTask {
  id: string;
  description: string;
  agent: string;
  status: string;
  attempts: number;
  reviewNotes?: string;
}

interface MissionView {
  id: string;
  runId: string;
  goal: string;
  status: string;
  reviewCycles: number;
  createdAt: number;
  updatedAt: number;
  tasks: MissionTask[];
}

const STATUS_COLORS: Record<string, string> = {
  QUEUED: "var(--text-muted)",
  PLANNING: "var(--accent)",
  RUNNING: "var(--accent)",
  WAITING: "#d9a662",
  TESTING: "var(--accent)",
  REVIEW: "#b58cf0",
  REWORK: "#d9a662",
  COMPLETED: "#5fbf77",
  FAILED: "#e06c75",
  CANCELLED: "var(--text-muted)",
  BLOCKED: "#e06c75",
};

interface McpServer {
  name: string;
  url?: string;
  status: "ready" | "error" | "pending";
  detail?: string;
  toolCount?: number;
}

export function MissionControl({ projectRoot }: { projectRoot: string | null }) {
  const [agents, setAgents] = useState<RosterAgent[]>([]);
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    async function refresh() {
      try {
        const mcpUrl = projectRoot ? `/mcp/servers?projectRoot=${encodeURIComponent(projectRoot)}` : "/mcp/servers";
        const [a, m, mcp] = await Promise.all([
          fetch(apiUrl("/agents"), { headers: authHeaders() }).then((r) => r.json()),
          fetch(apiUrl("/missions"), { headers: authHeaders() }).then((r) => r.json()),
          fetch(apiUrl(mcpUrl), { headers: authHeaders() }).then((r) => r.json()),
        ]);
        if (stop) return;
        setAgents(a.agents ?? []);
        setMissions(m.missions ?? []);
        setMcpServers(mcp.servers ?? []);
        setError(null);
      } catch (err: any) {
        if (!stop) setError(err.message);
      }
    }
    void refresh();
    const t = setInterval(refresh, 2500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [projectRoot]);

  return (
    <div style={{ height: "100%", overflowY: "auto", padding: 16, color: "var(--text)" }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Mission Control</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
        Past runs and multitask missions. Open one to bring that conversation back.
      </div>
      {error && (
        <div style={{ color: "#e06c75", fontSize: 12, marginBottom: 12 }}>Backend unreachable: {error}</div>
      )}

      <SectionTitle>Agents</SectionTitle>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 8, marginBottom: 20 }}>
        {agents.map((a) => (
          <div
            key={a.role}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              background: "var(--bg-panel)",
              opacity: a.status === "pending" ? 0.55 : 1,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: a.status === "ready" ? "#5fbf77" : "var(--text-muted)",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 13, fontWeight: 600 }}>{a.label}</span>
              {a.status === "pending" && (
                <span style={{ fontSize: 10, border: "1px solid var(--border-strong)", borderRadius: 4, padding: "1px 5px", color: "var(--text-muted)" }}>
                  Pending
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
              {a.status === "pending"
                ? a.pendingReason
                : `model: ${a.modelId ?? "none configured"} (${a.modelTask})`}
            </div>
          </div>
        ))}
        {agents.length === 0 && !error && <div style={{ fontSize: 12, color: "var(--text-muted)" }}>Loading roster…</div>}
      </div>

      <SectionTitle>MCP servers</SectionTitle>
      <div style={{ marginBottom: 20 }}>
        {mcpServers.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
            None configured. Declare servers in <code>.orvyn/mcp.json</code> and agents can reach them via the
            mcp_list / mcp_call tools.
          </div>
        ) : (
          mcpServers.map((s) => (
            <div key={s.name} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, marginBottom: 4 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  alignSelf: "center",
                  flexShrink: 0,
                  background: s.status === "ready" ? "#5fbf77" : s.status === "error" ? "#e06c75" : "var(--text-muted)",
                }}
              />
              <span style={{ fontWeight: 600 }}>{s.name}</span>
              <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
                {s.status === "ready" ? `${s.toolCount} tool(s)` : s.detail ?? s.status}
              </span>
            </div>
          ))
        )}
      </div>

      <SectionTitle>Missions</SectionTitle>
      {missions.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No runs yet. Start one from Home or the Build tab.
        </div>
      ) : (
        missions.map((m) => (
          <div
            key={m.id}
            title="Open this mission's workspace"
            onClick={() => document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: m.runId }))}
            style={{ border: "1px solid var(--border)", borderRadius: 8, padding: "10px 12px", background: "var(--bg-panel)", marginBottom: 10, cursor: "pointer" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLORS[m.status] ?? "var(--text)" }}>{m.status}</span>
              <span style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={m.goal}>
                {m.goal}
              </span>
            </div>
            {m.status === "BLOCKED" && (
              <div style={{ fontSize: 11, color: "#e06c75", marginTop: 4 }}>
                Failed final review after {m.reviewCycles} cycle{m.reviewCycles === 1 ? "" : "s"} — your decision is needed (see Review tab).
              </div>
            )}
            <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
              {m.tasks.map((t) => (
                <div key={t.id} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12, minWidth: 0 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, width: 78, flexShrink: 0, color: STATUS_COLORS[t.status] ?? "var(--text-muted)" }}>
                    {t.status}
                  </span>
                  <span style={{ fontSize: 10, color: "var(--text-muted)", width: 56, flexShrink: 0 }}>{t.agent}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }} title={t.description}>
                    {t.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, textTransform: "uppercase", color: "var(--text-secondary)", margin: "0 0 8px" }}>
      {children}
    </div>
  );
}
