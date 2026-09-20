// apps/desktop/src/renderer/components/Home.tsx
//
// Home = mission control (the approved redesign screen). All data is live
// from the same endpoints the old Home used; the presentation is the
// redesign's HomeScreen. Submitting still goes through the canonical
// submitOrvynCommand pipeline — the mockup controls presentation, real
// state controls content.

import React, { useCallback, useEffect, useState } from "react";
import { apiUrl, authHeaders } from "../connection";
import { submitOrvynCommand } from "../orvynCommand";
import { HomeScreen } from "./redesign/HomeScreen";
import { toMissionSummary, toSystems } from "./redesign/adapters";
import type { ComposerMode } from "./redesign/types";
import { useEngineStatus } from "../engineStatus";
import type { CommandMode } from "../orvynIntent";

interface MissionRow {
  id: string;
  runId?: string;
  goal: string;
  status: string;
  createdAt: string;
  tasks?: { status: string }[];
}

interface ServerRow {
  alias: string;
  host: string;
  user: string;
  port: number;
}

const STARTERS = [
  "Plan, code & test",
  "Diagnose & repair",
  "SSH, logs & services",
  "Build & deploy",
  "Browse & analyze",
  "Create a workflow",
];

export function Home({
  projectRoot,
  onOutcome,
  onOpenCommand,
}: {
  projectRoot: string | null;
  /** Called with the pipeline result so the shell can follow the work. */
  onOutcome: (outcome: { kind: "chat" } | { kind: "mission" | "run"; runId: string }) => void;
  onOpenCommand?: () => void;
}) {
  const [mode, setMode] = useState<ComposerMode>(() => {
    const saved = localStorage.getItem("orvyn:composer-mode");
    const valid = ["auto", "code", "server", "research", "deploy", "automate"];
    return saved && valid.includes(saved) ? (saved as ComposerMode) : "auto";
  });
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [missions, setMissions] = useState<MissionRow[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);
  const engine = useEngineStatus();
  const projectName = projectRoot ? (projectRoot.split(/[\\/]/).pop() ?? null) : null;

  const refresh = useCallback(async () => {
    try {
      const headers = authHeaders();
      const root = projectRoot ? `?projectRoot=${encodeURIComponent(projectRoot)}` : "";
      const [m, s, h] = await Promise.all([
        fetch(apiUrl("/missions"), { headers }).then((r) => r.json()).catch(() => ({ missions: [] })),
        fetch(apiUrl(`/servers${root}`), { headers }).then((r) => r.json()).catch(() => ({ servers: [] })),
        fetch(apiUrl("/../api/v1/health")).then((r) => r.ok).catch(() => false),
      ]);
      setMissions((m.missions ?? []).slice(0, 6));
      setServers(s.servers ?? []);
      setBackendOnline(Boolean(h));
    } catch {
      setBackendOnline(false);
    }
  }, [projectRoot]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function run(text: string, modeOverride?: ComposerMode) {
    const instruction = text.trim();
    if (!instruction || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      // The canonical pipeline — classification, routing and error handling
      // live in orvynCommand, not here.
      const outcome = await submitOrvynCommand({
        prompt: instruction,
        mode: (modeOverride ?? mode) as CommandMode,
        source: "HOME",
        projectRoot,
      });
      if (outcome.kind === "error") throw new Error(outcome.error);
      onOutcome(outcome);
    } catch (err: any) {
      // Keep the user's command on failure — never erase it silently.
      setStartError(err.message);
    } finally {
      setStarting(false);
    }
  }

  function openMission(id: string) {
    const row = missions.find((m) => m.id === id);
    if (row?.runId) document.dispatchEvent(new CustomEvent("orvyn:open-run", { detail: row.runId }));
    else document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: "missions" }));
  }

  function connectSystem(id: string) {
    const nav: Record<string, string> = {
      engine: "settings",
      github: "settings",
      ssh: "servers",
      postgres: "databases",
      docker: "containers",
      cloud: "settings",
    };
    document.dispatchEvent(new CustomEvent("orvyn:nav", { detail: nav[id] ?? "settings" }));
  }

  return (
    <>
      {startError && (
        <div style={{ padding: "8px 16px", color: "var(--orvyn-red, #F25F75)", fontSize: 12, flexShrink: 0 }}>
          {startError}
        </div>
      )}
      <HomeScreen
        userName="Royce"
        workspaceName={projectName ?? "No project"}
        status={engine}
        missions={missions.map(toMissionSummary)}
        systems={toSystems({
          engineReady: backendOnline !== false,
          githubConnected: false,
          sshHostCount: servers.length,
          postgresConnected: false,
          dockerConnected: false,
          cloudSignedIn: backendOnline === true,
        })}
        starters={STARTERS}
        agentName="Astra"
        agentRole="Orchestrator"
        onRun={(p, m) => {
          setMode(m);
          localStorage.setItem("orvyn:composer-mode", m);
          void run(p, m);
        }}
        onOpenMission={openMission}
        onMissionAction={openMission}
        onConnectSystem={connectSystem}
        onOpenCommand={onOpenCommand}
      />
    </>
  );
}
