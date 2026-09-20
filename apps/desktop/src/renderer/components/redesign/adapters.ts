// apps/desktop/src/renderer/components/redesign/adapters.ts
// Maps the mission / server rows the current Home.tsx already fetches onto the
// redesign's view models, so the new screens show live data.
import type { MissionSummary, MissionTone, SystemItem } from "./types";

/** Same shape Home.tsx uses for rows from the missions API. */
export interface ApiMissionRow {
  id: string;
  runId?: string;
  goal: string;
  status: string;
  createdAt: string;
  tasks?: { status: string }[];
  /** Optional: a human-readable reason from the backend, if you add one. */
  blockedReason?: string;
  error?: string;
  agent?: string;
}

const TONE: Record<string, { tone: MissionTone; label: string; action?: string }> = {
  REVIEW: { tone: "approval", label: "Needs approval", action: "Review" },
  BLOCKED: { tone: "blocked", label: "Blocked", action: "Resolve" },
  PAUSED: { tone: "paused", label: "Paused", action: "Resume" },
  FAILED: { tone: "failed", label: "Failed", action: "Retry" },
  RUNNING: { tone: "running", label: "Running", action: "Open" },
  PLANNING: { tone: "running", label: "Planning", action: "Open" },
  COMPLETED: { tone: "done", label: "Completed", action: "Open" },
};

const DEFAULT_REASON: Record<MissionTone, string> = {
  approval: "Waiting for your approval to continue",
  blocked: "Blocked — open the mission to see what it needs",
  paused: "Paused — resume when ready",
  failed: "A step failed — open the run log for details",
  running: "In progress",
  done: "Finished",
};

export function relTime(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function toMissionSummary(row: ApiMissionRow): MissionSummary {
  const t = TONE[row.status.toUpperCase()] ?? { tone: "running" as MissionTone, label: row.status };
  const tasks = row.tasks ?? [];
  const done = tasks.filter((x) => x.status.toUpperCase() === "COMPLETED").length;
  return {
    id: row.id,
    title: row.goal,
    reason: row.blockedReason ?? row.error ?? DEFAULT_REASON[t.tone],
    meta: [row.id, row.agent].filter(Boolean).join(" · "),
    tone: t.tone,
    label: t.label,
    stepsDone: done,
    stepsTotal: tasks.length,
    timeAgo: relTime(row.createdAt),
    action: t.action,
  };
}

/** Builds the "Connect your stack" list from what the app knows is configured. */
export function toSystems(state: {
  engineReady: boolean;
  githubConnected: boolean;
  sshHostCount: number;
  postgresConnected: boolean;
  dockerConnected: boolean;
  cloudSignedIn: boolean;
}): SystemItem[] {
  return [
    { id: "engine", name: "Local engine", description: state.engineReady ? "Running on this machine" : "Starting…", icon: "cpu", connected: state.engineReady },
    { id: "github", name: "GitHub", description: "Repos & pull requests", icon: "git", connected: state.githubConnected },
    {
      id: "ssh",
      name: "Servers (SSH)",
      description: state.sshHostCount > 0 ? `${state.sshHostCount} host${state.sshHostCount === 1 ? "" : "s"} configured` : "Run commands, tail logs, restart services",
      icon: "server",
      connected: state.sshHostCount > 0,
      cta: "Add host",
    },
    { id: "postgres", name: "PostgreSQL", description: "Query and inspect databases", icon: "database", connected: state.postgresConnected },
    { id: "docker", name: "Docker", description: "Manage containers and images", icon: "box", connected: state.dockerConnected },
    { id: "cloud", name: "ORVYN Cloud", description: "Sync missions across devices", icon: "cloud", connected: state.cloudSignedIn, cta: "Sign in" },
  ];
}
