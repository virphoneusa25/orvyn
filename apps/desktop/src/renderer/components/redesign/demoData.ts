// apps/desktop/src/renderer/components/redesign/demoData.ts
// The exact content shown in the mockup. Use it for the preview, then replace
// with real data (see README for the mapping).
import type {
  EngineStatus,
  MissionDetailData,
  MissionSummary,
  SystemItem,
  UsageInfo,
  UserInfo,
  WorkspaceInfo,
} from "./types";

export const demoUser: UserInfo = { name: "Royce", subtitle: "Local mode · not synced" };
export const demoWorkspace: WorkspaceInfo = { name: "virphone", subtitle: "Local workspace" };
export const demoUsage: UsageInfo = { valueLabel: "4.54M", limitLabel: "of [PLAN LIMIT]", percent: 45 };

export const demoStatus: EngineStatus = {
  engineReady: true,
  cloudOnline: false,
  lastRun: "completed",
  cpu: 26,
  ram: 80,
  disk: 82,
  agentsRunning: 0,
};

export const demoMissions: MissionSummary[] = [
  {
    id: "mission_ba4e",
    tone: "approval",
    label: "Needs approval",
    title: "Inspect apps/backend: read package.json and map dependencies",
    reason: "Waiting for you to approve a command: npm ci --ignore-scripts",
    meta: "mission_ba4e · Astra",
    stepsDone: 1,
    stepsTotal: 5,
    timeAgo: "15h ago",
    action: "Review",
  },
  {
    id: "mission_dd13",
    tone: "blocked",
    label: "Blocked",
    title: "Review the ORVYN codebase and post results",
    reason: "GitHub isn’t connected, so the agent can’t read the repository",
    meta: "mission_dd13 · Astra",
    stepsDone: 0,
    stepsTotal: 3,
    timeAgo: "14h ago",
    action: "Connect",
  },
  {
    id: "mission_4e81",
    tone: "paused",
    label: "Paused",
    title: "Full application health check of the ORVYN project",
    reason: "Paused when ORVYN Cloud went offline — resume locally or reconnect",
    meta: "mission_4e81 · Astra",
    stepsDone: 2,
    stepsTotal: 10,
    timeAgo: "15h ago",
    action: "Resume",
  },
  {
    id: "mission_ece8",
    tone: "failed",
    label: "Failed",
    title: "Review my website",
    reason: "Browser step failed on attempt 3 — open the run log for details",
    meta: "mission_ece8 · 3 attempts",
    stepsDone: 1,
    stepsTotal: 2,
    timeAgo: "13h ago",
    action: "Retry",
  },
];

export const demoSystems: SystemItem[] = [
  { id: "engine", name: "Local engine", description: "Running on this machine", icon: "cpu", connected: true },
  { id: "github", name: "GitHub", description: "Repos & pull requests · unblocks 1 mission", icon: "git", connected: false },
  { id: "ssh", name: "Servers (SSH)", description: "Run commands, tail logs, restart services", icon: "server", connected: false, cta: "Add host" },
  { id: "postgres", name: "PostgreSQL", description: "Query and inspect databases", icon: "database", connected: false },
  { id: "docker", name: "Docker", description: "Manage containers and images", icon: "box", connected: false },
  { id: "cloud", name: "ORVYN Cloud", description: "Sync missions across devices", icon: "cloud", connected: false, cta: "Sign in" },
];

export const demoMission: MissionDetailData = {
  id: "mission_ba4e",
  title: "Inspect apps/backend and map dependencies",
  tone: "approval",
  label: "Needs approval",
  meta: ["mission_ba4e", "agent · Astra", "project · virphone", "runs on · local engine", "started 15h ago"],
  steps: [
    { id: "s1", title: "Read package.json", detail: "Found the manifest in apps/backend", state: "done" },
    { id: "s2", title: "Resolve dependency tree", detail: "Waiting on your approval to install", state: "current" },
    { id: "s3", title: "Check versions & advisories", detail: "Outdated and vulnerable packages", state: "todo" },
    { id: "s4", title: "Find unused dependencies", detail: "Cross-reference imports in src/", state: "todo" },
    { id: "s5", title: "Write the report", detail: "Summary with recommended upgrades", state: "todo" },
  ],
  activity: [
    {
      kind: "user",
      id: "a1",
      author: "You",
      initial: "R",
      time: "15h ago",
      text: "Inspect this repository’s apps/backend directory: read its package.json and tell me what it depends on.",
    },
    {
      kind: "agent",
      id: "a2",
      agent: "Astra",
      time: "15h ago",
      tools: [{ id: "t1", ok: true, verb: "Read file", target: "apps/backend/package.json" }],
      text:
        "I’ve read the manifest. Direct dependencies are listed, but to map the full tree — transitive packages, versions actually resolved, and known advisories — I need to install them into a local sandbox. Nothing will be deployed or committed.",
      approval: {
        id: "req1",
        cwd: "~/virphone/apps/backend",
        command: "npm ci --ignore-scripts",
        runsOn: "local engine · virphone",
        effects: ["Writes · node_modules/", "Network · npm registry", "Install scripts · disabled"],
        rememberLabel: "Always allow npm installs in this project",
      },
    },
  ],
  permissions: [
    { name: "Read files", level: "allowed" },
    { name: "Run commands", level: "ask" },
    { name: "Network", level: "ask" },
    { name: "Deploy", level: "off" },
  ],
  budget: { usedLabel: "[TOKENS USED]", capLabel: "[MISSION CAP]", percent: 12 },
  files: [{ path: "apps/backend/package.json", op: "read" }],
  deliverable:
    "A dependency report: direct and transitive packages, outdated versions, and security advisories — saved to the mission and optionally posted as a GitHub issue.",
};
