// Website repair stays on the same run. Escalation is a model handoff, not a new mission.

export type WebsitePhase =
  | "planning"
  | "implementing"
  | "building"
  | "starting"
  | "browser_verification"
  | "repairing_build"
  | "repairing_visual"
  | "responsive_verification"
  | "completed";

export interface WebsiteMissionState {
  phase: WebsitePhase;
  buildAttempts: number;
  visualAttempts: number;
  failures: string[];
  lastBuildResult?: string;
  lastBrowserResult?: string;
}

export function emptyWebsiteMission(): WebsiteMissionState {
  return { phase: "implementing", buildAttempts: 0, visualAttempts: 0, failures: [] };
}

const BUILD_CMD = /\b(npm|pnpm|yarn)\b.*\b(run\s+)?(build|tsc|typecheck)\b|\bvite build\b/i;
const VISUAL_TOOL = /browser|screenshot/i;

export function isBuildCommand(command: string): boolean {
  return BUILD_CMD.test(command);
}

export function isVisualTool(name: string): boolean {
  return VISUAL_TOOL.test(name);
}

/** Identical compiler/runtime lines count as one fingerprint. */
export function failureFingerprint(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => /error TS\d+|npm ERR!|Error:|Module not found|failed/i.test(l));
  return (line ?? text).replace(/\s+/g, " ").slice(0, 180);
}

export interface RepairDecision {
  phase: WebsitePhase;
  escalate: 0 | 1 | 2;
  budgetExceeded: boolean;
  reason: string;
}

const BUDGET = 6;

/**
 * Attempts 1–2 stay on the current lane (Kimi when Auto started there).
 * The same fingerprint twice, or three build failures, moves to GLM.
 * Five build failures move to Sol. Six failures stop the mission.
 */
export function decideBuildRepair(mission: WebsiteMissionState, fingerprint: string): RepairDecision {
  const repeats = mission.failures.filter((f) => f === fingerprint).length + 1;
  const attempts = mission.buildAttempts + 1;
  if (attempts > BUDGET) {
    return { phase: "repairing_build", escalate: 2, budgetExceeded: true, reason: "Website repair budget is exhausted." };
  }
  let escalate: 0 | 1 | 2 = 0;
  if (attempts >= 5 || repeats >= 4) escalate = 2;
  else if (attempts >= 3 || repeats >= 2) escalate = 1;
  return {
    phase: "repairing_build",
    escalate,
    budgetExceeded: false,
    reason: escalate === 0 ? "Build failed. Repair stays on the current model." : `Build failed ${attempts} times. Escalate.`,
  };
}

export function decideVisualRepair(mission: WebsiteMissionState, fingerprint: string): RepairDecision {
  const repeats = mission.failures.filter((f) => f === fingerprint).length + 1;
  const attempts = mission.visualAttempts + 1;
  if (mission.buildAttempts + attempts > BUDGET) {
    return { phase: "repairing_visual", escalate: 2, budgetExceeded: true, reason: "Website repair budget is exhausted." };
  }
  let escalate: 0 | 1 | 2 = 0;
  if (attempts >= 4 || repeats >= 3) escalate = 2;
  else if (attempts >= 2 || repeats >= 2) escalate = 1;
  return {
    phase: "repairing_visual",
    escalate,
    budgetExceeded: false,
    reason: escalate === 0 ? "Visual check failed. Repair stays on the current model." : "Visual defect repeated. Escalate.",
  };
}
