// apps/desktop/src/renderer/components/StatusBar.tsx
//
// The mockup's global status bar. Everything shown is live: backend health,
// version, running agent runs, active missions. CPU/RAM/Disk have no IPC
// source yet and are omitted rather than faked (audit note).
import React, { useEffect, useState } from "react";
import { apiUrl, authHeaders, getConnectionConfig } from "../connection";

interface Health {
  status: string;
  version?: string;
}

interface StatusBarState {
  health: Health | null;
  runningRuns: number;
  activeMissions: number;
}

export function StatusBar() {
  const [state, setState] = useState<StatusBarState>({ health: null, runningRuns: 0, activeMissions: 0 });

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const headers = authHeaders();
        const [h, runs, missions] = await Promise.all([
          fetch(apiUrl("/../api/v1/health")).then((r) => r.json()).catch(() => null),
          fetch(apiUrl("/agent/stream/runs"), { headers }).then((r) => r.json()).catch(() => ({ runs: [] })),
          fetch(apiUrl("/missions"), { headers }).then((r) => r.json()).catch(() => ({ missions: [] })),
        ]);
        if (!alive) return;
        const running = (runs.runs ?? []).filter(
          (r: { status: string }) => r.status === "running" || r.status === "awaiting_approval"
        ).length;
        const active = (missions.missions ?? []).filter((m: { status: string }) =>
          ["RUNNING", "PLANNING", "REVIEW", "QUEUED"].includes(m.status)
        ).length;
        setState({ health: h, runningRuns: running, activeMissions: active });
      } catch {
        if (alive) setState((s) => ({ ...s, health: null }));
      }
    }
    void load();
    const timer = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const cfg = getConnectionConfig();
  const online = state.health?.status === "ok";
  const backendName = cfg.backendUrl?.replace(/^https?:\/\//, "").split("/")[0] || "backend";

  return (
    <div
      style={{
        height: "var(--orvyn-status-height)",
        flexShrink: 0,
        background: "var(--orvyn-surface-1)",
        borderTop: "1px solid var(--orvyn-border-soft)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 12px",
        fontSize: 11,
        color: "var(--orvyn-text-muted)",
        userSelect: "none",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: online ? "var(--orvyn-green)" : "var(--orvyn-red)",
            boxShadow: online ? "0 0 6px var(--orvyn-green)" : "none",
          }}
        />
        {online ? `Connected · ${backendName}` : "Backend offline"}
      </span>
      {state.health?.version && <span>v{state.health.version}</span>}
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 14 }}>
        <span>
          {state.runningRuns} agent{state.runningRuns === 1 ? "" : "s"} running
        </span>
        <span>
          {state.activeMissions} active mission{state.activeMissions === 1 ? "" : "s"}
        </span>
      </span>
    </div>
  );
}
