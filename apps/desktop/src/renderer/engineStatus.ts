// apps/desktop/src/renderer/engineStatus.ts
//
// Live engine status for the redesign shell (StatusFooter + Sidebar). Every
// value is real: backend health, running agents, and the OS-level
// CPU/RAM/Disk sample from the main process — no faked indicators.

import { useEffect, useState } from "react";
import { apiUrl, authHeaders } from "./connection";
import type { EngineStatus } from "./components/redesign/types";

export interface EngineStatusLive extends EngineStatus {
  /** Timestamp label of the most recent run, e.g. "2m ago". */
  lastRun?: string;
}

function ago(iso: number): string {
  const s = Math.max(0, (Date.now() - iso) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function useEngineStatus(): EngineStatusLive {
  const [status, setStatus] = useState<EngineStatusLive>({ engineReady: true, cloudOnline: false, agentsRunning: 0 });

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [h, runs, stats] = await Promise.all([
          fetch(apiUrl("/../api/v1/health")).then((r) => r.json()).catch(() => null),
          fetch(apiUrl("/agent/stream/runs"), { headers: authHeaders() }).then((r) => r.json()).catch(() => ({ runs: [] })),
          window.orvyn?.system?.getStats?.().catch(() => null) ?? null,
        ]);
        if (!alive) return;
        const list = runs.runs ?? [];
        const running = list.filter((r: { status: string }) => ["running", "awaiting_approval", "queued"].includes(r.status));
        const latest = list[0];
        setStatus({
          engineReady: h?.status === "ok",
          cloudOnline: h?.status === "ok",
          agentsRunning: running.length,
          lastRun: latest ? ago(latest.createdAt) : undefined,
          cpu: stats?.cpuPercent,
          ram: stats?.ramPercent,
          disk: stats?.diskPercent,
        });
      } catch {
        if (alive) setStatus((s) => ({ ...s, engineReady: false, cloudOnline: false }));
      }
    }
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return status;
}

/** Missions waiting on the user (approval/blocked) — Sidebar badge. */
export function useMissionsNeedingYou(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(apiUrl("/missions"), { headers: authHeaders() })
        .then((r) => r.json())
        .then((d) => {
          if (alive) setN((d.missions ?? []).filter((m: { status: string }) => ["REVIEW", "BLOCKED", "PAUSED"].includes(m.status)).length);
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  return n;
}
