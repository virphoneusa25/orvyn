// apps/desktop/src/renderer/components/StatusBar.tsx
//
// The mockup's global status bar. Everything shown is live: backend health,
// version, running agent runs, active missions. CPU/RAM/Disk have no IPC
// source yet and are omitted rather than faked (audit note).
import React, { useEffect, useState } from "react";
import { authHeaders, apiUrl, healthUrl, noteProtectedStatus } from "../connection";
import { describeConnection, type ConnectionPresentation } from "../connectionState";
import { getConnectionFacts, onConnectionFacts } from "../connectionRuntime";
import { shortBuildSha } from "../buildInfo";
import { ServicesIndicator } from "./ServicesIndicator";

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
  const [connection, setConnection] = useState<ConnectionPresentation>(() => describeConnection(getConnectionFacts()));
  const [state, setState] = useState<StatusBarState>({
    health: null,
    runningRuns: 0,
    activeMissions: 0,
    stats: null,
  });

  useEffect(() => {
    const offConnection = onConnectionFacts((facts) => setConnection(describeConnection(facts)));
    let alive = true;
    async function load() {
      try {
        const headers = authHeaders();
        const runsUrl = apiUrl("/agent/stream/runs");
        const missionsUrl = apiUrl("/missions");
        const [h, runsRes, missionsRes, stats] = await Promise.all([
          fetch(healthUrl()).then((r) => r.json()).catch(() => null),
          fetch(runsUrl, { headers }).then((r) => {
            noteProtectedStatus(r.status, runsUrl);
            return r.json();
          }).catch(() => ({ runs: [] })),
          fetch(missionsUrl, { headers }).then((r) => {
            noteProtectedStatus(r.status, missionsUrl);
            return r.json();
          }).catch(() => ({ missions: [] })),
          window.orvyn.system?.getStats?.().catch(() => null) ?? null,
        ]);
        const runs = runsRes;
        const missions = missionsRes;
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
      offConnection();
    };
  }, []);

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
      {connection.indicators.map((item) => (
        <span key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: item.tone === "on" ? "var(--orvyn-green)" : item.tone === "pending" ? "var(--orvyn-amber, #e6b35a)" : "transparent",
              border: item.tone === "off" ? "1.5px solid var(--orvyn-text-muted)" : "none",
              boxSizing: "border-box",
            }}
          />
          {item.label}
        </span>
      ))}
      {state.health?.version && <span>v{state.health.version}</span>}
      <span title="Desktop build identity. Packaged Electron does not update from git until you install a new build.">Desktop {shortBuildSha()}</span>
      <span>Backend: {connection.statusFacts.backend}</span>
      <span>Account: {connection.statusFacts.account}</span>
      <span>Worker: {connection.statusFacts.worker}</span>
      <span>{connection.modeLabel}</span>
      <span style={{ marginLeft: "auto", display: "inline-flex", gap: 16 }}>
        {state.stats && (
          <>
            <span>CPU {state.stats.cpuPercent}%</span>
            <span>RAM {state.stats.ramPercent}%</span>
            {state.stats.diskPercent > 0 && <span>Disk {state.stats.diskPercent}%</span>}
          </>
        )}
        <ServicesIndicator />
        <span>
          {state.runningRuns} running
        </span>
        <span>
          {state.activeMissions} mission{state.activeMissions === 1 ? "" : "s"}
        </span>
      </span>
    </div>
  );
}
