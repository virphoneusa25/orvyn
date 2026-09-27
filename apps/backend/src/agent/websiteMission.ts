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
  return { phase: "planning", buildAttempts: 0, visualAttempts: 0, failures: [] };
}

export interface WebsiteEvidence {
  inspected: boolean;
  wrotePage: boolean;
  preview: boolean;
  browserOpened: boolean;
}

const INSPECT_TOOL = /^(list_directory|list_files|read_file|search_files|search_code|search_codebase)$/;

/** What the run has actually done. Model prose does not count. */
export function websiteEvidenceFrom(events: Array<{ type: string; data?: Record<string, unknown> }>): WebsiteEvidence {
  let inspected = false;
  let wrotePage = false;
  let preview = false;
  let browserOpened = false;
  for (const event of events) {
    const tool = String(event.data?.tool ?? "");
    const verifier = Boolean(event.data?.verifier);
    if (event.type === "tool.completed" && !verifier && INSPECT_TOOL.test(tool)) inspected = true;
    if ((event.type === "file.created" || event.type === "file.edit") && /\.(html|css|js|php)$/i.test(String(event.data?.path ?? ""))) wrotePage = true;
    if ((event.type === "preview.available" || event.type === "preview.updated") && String(event.data?.url ?? "")) preview = true;
    if (event.type === "browser.completed" || (event.type === "tool.completed" && !verifier && /^browser_/.test(tool))) browserOpened = true;
  }
  return { inspected, wrotePage, preview, browserOpened };
}

/**
 * Inspect → write → serve → browser. Repair phases stay put until the
 * failure handler moves them. A ready site is completed only for the agent's
 * own steps; the independent verifier still has to pass.
 */
export function syncWebsitePhase(mission: WebsiteMissionState, evidence: WebsiteEvidence): WebsitePhase {
  if (mission.phase === "repairing_build" || mission.phase === "repairing_visual") return mission.phase;
  const ready = evidence.wrotePage && evidence.preview && evidence.browserOpened;
  let phase: WebsitePhase;
  if (ready) phase = "completed";
  else if (!evidence.wrotePage && !evidence.inspected) phase = "planning";
  else if (!evidence.wrotePage) phase = "implementing";
  else if (!evidence.preview) phase = "starting";
  else phase = "browser_verification";
  mission.phase = phase;
  return phase;
}

/** Model-facing instruction for the current phase. This is not a chat message. */
export function websiteActionPrompt(phase: WebsitePhase): string {
  switch (phase) {
    case "planning":
      return "Continue now: inspect the workspace with list_directory. If the user asked for current references, call web_search first. Call the tool in this turn. Do not describe the step.";
    case "implementing":
      return "Continue now: call write_file with both path and content. First write index.html (navigation and hero) and styles.css (base theme) if they are missing, then add sections by updating those same files. Do not create a numbered copy. Do not describe the step, and do not say the folder is empty instead of writing.";
    case "building":
    case "starting":
      return "Continue now: the page files exist. Do not start a shell server. The preview is published from those files. Call browser_open on the preview URL, then browser_screenshot. Do not describe the step.";
    case "browser_verification":
    case "responsive_verification":
      return "Continue now: open the shared browser on the preview URL with browser_open and take browser_screenshot. Do not describe the step.";
    case "repairing_build":
    case "repairing_visual":
      return "Continue now: repair the defect with write_file or edit_file, then browser_screenshot the page again. Do not describe the step.";
    case "completed":
      return "Continue now: perform the step you just described by calling the appropriate tool. Do not describe it again.";
  }
}

const WEBSITE_TASK = /\b(website|web\s*site|landing\s*page|homepage|home\s*page|joomla)\b/i;
const BUILD_TASK = /\b(build|create|make|design|generate)\b/i;
const BUILD_CMD = /\b(npm|pnpm|yarn)\b.*\b(run\s+)?(build|tsc|typecheck)\b|\bvite build\b/i;

/** A site to build, not a one-off write of a file whose name happens to contain "html". */
export function isWebsiteImplementation(instruction: string): boolean {
  return WEBSITE_TASK.test(instruction) && BUILD_TASK.test(instruction);
}
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
