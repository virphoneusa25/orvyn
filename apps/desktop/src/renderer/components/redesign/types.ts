// apps/desktop/src/renderer/components/redesign/types.ts
// View models for the redesigned screens. The screens are presentational:
// map your real API data (missions, runs, servers, usage) onto these shapes.
import type { IconName } from "./icons";

export type MissionTone = "approval" | "blocked" | "paused" | "failed" | "running" | "done";

export interface MissionSummary {
  id: string;
  title: string;
  /** One plain-language line: why it's stuck / what it's doing. */
  reason: string;
  /** Mono meta line, e.g. "mission_ba4e · Astra". */
  meta: string;
  tone: MissionTone;
  /** Badge text, e.g. "Needs approval", "Blocked", "Failed". */
  label: string;
  stepsDone: number;
  stepsTotal: number;
  /** e.g. "15h ago" */
  timeAgo: string;
  /** Row button text, e.g. "Review", "Connect", "Retry". Omit to hide. */
  action?: string;
}

export type MissionFilter = "all" | "needs-you" | "failed" | "running";

export interface SystemItem {
  id: string;
  name: string;
  description: string;
  icon: IconName;
  connected: boolean;
  /** Button text when not connected. Defaults to "Connect". */
  cta?: string;
}

export interface UsageInfo {
  /** e.g. "4.54M" */
  valueLabel: string;
  /** e.g. "of 10M" */
  limitLabel: string;
  /** 0–100 */
  percent: number;
}

export interface EngineStatus {
  engineReady: boolean;
  cloudOnline: boolean;
  lastRun?: string;
  cpu?: number;
  ram?: number;
  disk?: number;
  agentsRunning: number;
}

export interface UserInfo {
  name: string;
  subtitle: string;
}

export interface WorkspaceInfo {
  name: string;
  subtitle: string;
}

export type ComposerMode = "auto" | "code" | "server" | "research" | "deploy" | "automate";

// ── Mission detail ──

export type StepState = "done" | "current" | "todo";

export interface PlanStep {
  id: string;
  title: string;
  detail: string;
  state: StepState;
}

export type ActivityItem =
  | { kind: "user"; id: string; author: string; initial: string; time: string; text: string }
  | { kind: "agent"; id: string; agent: string; time: string; text: string; tools?: ToolCall[]; approval?: ApprovalRequest }
  | { kind: "approval"; id: string; request: ApprovalRequest };

export interface ToolCall {
  id: string;
  ok: boolean;
  verb: string;
  target: string;
}

export interface ApprovalRequest {
  id: string;
  cwd: string;
  command: string;
  runsOn: string;
  effects: string[];
  rememberLabel: string;
}

export type PermissionLevel = "allowed" | "ask" | "off";

export interface MissionPermission {
  name: string;
  level: PermissionLevel;
}

export interface TouchedFile {
  path: string;
  op: "read" | "write";
}

export interface MissionDetailData {
  id: string;
  title: string;
  tone: MissionTone;
  label: string;
  meta: string[];
  steps: PlanStep[];
  activity: ActivityItem[];
  permissions: MissionPermission[];
  budget: { usedLabel: string; capLabel: string; percent: number };
  files: TouchedFile[];
  deliverable: string;
}
