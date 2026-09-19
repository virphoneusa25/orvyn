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
  stats: { cpuPercent: number; ramPercent: number; diskPercent: number } | null;
}

export function StatusBar() {
  const [state, setState] = useState<StatusBarState>({
    health: null,
    runningRuns: 0,
    activeMissions: 0,
    stats: null,
  });

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const headers = authHeaders();
        const [h, runs, missions, stats] = await Promise.all([
          fetch(apiUrl("/../api/v1/health")).then((r) => r.json()).catch(() => null),
          fetch(apiUrl("/agent/stream/runs"), { headers }).then((r) => r.json()).catch(() => ({ runs: [] })),
          fetch(apiUrl("/missions"), { headers }).then((r) => r.json()).catch(() => ({ missions: [] })),
          window.orvyn.system?.getStats?.().catch(() => null) ?? null,
        ]);
        if (!alive) return;
        const running = (runs.runs ?? []).filter(
          (r: { status: string }) => r.status === "running" || r.status === "awaiting_approval"
        ).length;
        const active = (missions.missions ?? []).filter((m: { status: string }) =>
          ["RUNNING", "PLANNING", "REVIEW", "QUEUED"].includes(m.status)
        ).length;
        setState({ health: h, runningRuns: running, activeMissions: active, stats });
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
        gap: 16,
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
            background: online ? "var(--orvyn-green)" : "var(--orvyn-text-muted)",
          }}
        />
        ORVYN Cloud {online ? `Online · ${backendName}` : "Offline"}
      </span>
      {/* Local engine readiness is independent of cloud reachability:
          files, editor, git, terminal and local config all work either way. */}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--orvyn-green)" }} />
        Local Engine Ready
      </span>
      {state.health?.version && <span>v{state.health.version}</span>}
      <span>{cfg.backendUrl?.includes("localhost") ? "Local" : "Cloud"}</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 16 }}>
        {state.stats && (
          <>
            <span>CPU {state.stats.cpuPercent}%</span>
            <span>RAM {state.stats.ramPercent}%</span>
            {state.stats.diskPercent > 0 && <span>Disk {state.stats.diskPercent}%</span>}
          </>
        )}
        <span>
          {state.runningRuns} agent{state.runningRuns === 1 ? "" : "s"}
        </span>
        <span>
          {state.activeMissions} mission{state.activeMissions === 1 ? "" : "s"}
        </span>
      </span>
    </div>
  );
}
