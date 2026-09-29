// apps/desktop/src/renderer/onboarding/onboardingModel.ts
//
// Pure onboarding rules (no DOM, no network): the step order, which progress
// segment a step belongs to, recap labels, password strength, and the local
// draft kept while the server is unreachable. The server stays authoritative.

export const STEPS = [
  "welcome",
  "signup",
  "verification",
  "provisioning",
  "name",
  "primary_use",
  "goals",
  "work_style",
  "response_style",
  "memory",
  "workspace",
  "github",
  "plan",
  "recap",
  "first_mission",
  "complete",
] as const;
export type Step = (typeof STEPS)[number];

export interface Answers {
  name?: string;
  primaryUse?: string[];
  goals?: string[];
  goalOther?: string;
  workStyle?: "plan_first" | "move_fast" | "adaptive";
  responseStyle?: "concise" | "balanced" | "detailed" | "adaptive";
  memory?: boolean;
  workspace?: { choice: "new_project" | "local_folder" | "clone_repo" | "github" | "none"; path?: string; repoUrl?: string; projectName?: string };
  githubConnected?: boolean;
  firstMission?: string;
}

export interface Profile {
  id: string;
  currentStep: Step;
  completedSteps: Step[];
  answers: Answers;
  completedAt: number | null;
  updatedAt: number;
}

/** Major stages shown as the segmented progress bar. */
export const STAGES: { id: string; steps: Step[] }[] = [
  { id: "account", steps: ["welcome", "signup", "verification", "provisioning"] },
  { id: "you", steps: ["name", "primary_use", "goals"] },
  { id: "orion", steps: ["work_style", "response_style", "memory"] },
  { id: "workspace", steps: ["workspace", "github"] },
  { id: "plan", steps: ["plan", "recap"] },
  { id: "start", steps: ["first_mission", "complete"] },
];

export type SegmentState = "done" | "current" | "future";

export function progressSegments(step: Step): SegmentState[] {
  const at = STAGES.findIndex((s) => s.steps.includes(step));
  return STAGES.map((_, i) => (i < at ? "done" : i === at ? "current" : "future"));
}

export function nextStep(step: Step): Step {
  const i = STEPS.indexOf(step);
  return STEPS[Math.min(STEPS.length - 1, i + 1)]!;
}

/** Back never returns to account creation, verification or provisioning once they are behind. */
export function previousStep(step: Step): Step | null {
  const i = STEPS.indexOf(step);
  if (i <= STEPS.indexOf("name")) return step === "signup" ? "welcome" : null;
  return STEPS[i - 1]!;
}

export const PRIMARY_USE_OPTIONS = [
  { id: "software", label: "Software Development", icon: "code" },
  { id: "devops", label: "Server / DevOps", icon: "server" },
  { id: "research", label: "Research", icon: "search" },
  { id: "business", label: "Business & Operations", icon: "briefcase" },
  { id: "automation", label: "Automation", icon: "gear" },
  { id: "everything", label: "Everything", icon: "spark" },
] as const;

export const GOAL_OPTIONS = [
  { id: "build_software", label: "Build software faster" },
  { id: "servers_deployments", label: "Manage servers and deployments" },
  { id: "research", label: "Research complex topics" },
  { id: "automate", label: "Automate repetitive work" },
  { id: "websites_apps", label: "Build websites and applications" },
  { id: "analyze_data", label: "Analyze data" },
  { id: "other", label: "Other (tell me...)" },
] as const;

export const WORK_STYLE_OPTIONS = [
  { id: "plan_first", label: "Plan First", detail: "Show the plan before major work and keep progress visible.", icon: "plan" },
  { id: "move_fast", label: "Move Fast", detail: "Start executing quickly and adapt as the work develops.", icon: "bolt" },
  { id: "adaptive", label: "Adaptive", detail: "Choose based on the task.", icon: "adapt" },
] as const;

export const RESPONSE_STYLE_OPTIONS = [
  { id: "concise", label: "Concise", detail: "Short and direct responses.", icon: "concise" },
  { id: "balanced", label: "Balanced", detail: "Clear and helpful (recommended).", icon: "balanced" },
  { id: "detailed", label: "Detailed", detail: "In-depth explanations.", icon: "detailed" },
  { id: "adaptive", label: "Adaptive", detail: "Adjust based on the task.", icon: "adapt" },
] as const;

export const WORKSPACE_OPTIONS = [
  { id: "new_project", label: "Create a new project", icon: "plus" },
  { id: "local_folder", label: "Open a local folder", icon: "folder" },
  { id: "clone_repo", label: "Clone a Git repository", icon: "git" },
  { id: "github", label: "Connect GitHub", icon: "github" },
  { id: "none", label: "Start without a project", icon: "none" },
] as const;

export const FIRST_MISSIONS = [
  { id: "website", label: "Build a website", detail: "Create a modern website from scratch", prompt: "Build a modern, responsive website for my business. Ask me for the name and what it does first if you need to.", mode: "code" },
  { id: "fix", label: "Fix a coding problem", detail: "Get help with your code", prompt: "Help me fix a problem in my code. Look at the project first, then ask me what's going wrong.", mode: "code" },
  { id: "review", label: "Review a repository", detail: "Analyze and understand your project", prompt: "Review this repository: explain its structure, how it works, and the most important issues or improvements.", mode: "code" },
  { id: "server", label: "Connect to a server", detail: "Set up and manage a server", prompt: "Help me connect to one of my servers and check its health.", mode: "server" },
  { id: "research", label: "Research a topic", detail: "Deep research on anything", prompt: "Research a topic for me with sources. Ask me what topic first.", mode: "research" },
  { id: "automate", label: "Automate a workflow", detail: "Create custom automations", prompt: "Help me automate a repetitive workflow. Ask me what I do repeatedly first.", mode: "automate" },
] as const;

const label = <T extends { id: string; label: string }>(list: readonly T[], id?: string) => list.find((o) => o.id === id)?.label ?? "";

/** The recap rows (label, value, the step its Edit returns to). */
export function recapRows(a: Answers, extras: { githubConnected?: boolean } = {}): { key: string; label: string; value: string; step: Step }[] {
  const uses = (a.primaryUse ?? []).map((u) => label(PRIMARY_USE_OPTIONS, u)).filter(Boolean);
  const goals = (a.goals ?? []).map((g) => (g === "other" ? a.goalOther || "Other" : label(GOAL_OPTIONS, g))).filter(Boolean);
  return [
    { key: "name", label: "Name", value: a.name || "—", step: "name" },
    { key: "primary_use", label: "Primary use", value: uses.join(", ") || "—", step: "primary_use" },
    { key: "goals", label: "Goals", value: goals.join(", ") || "—", step: "goals" },
    { key: "work_style", label: "Work style", value: label(WORK_STYLE_OPTIONS, a.workStyle) || "Adaptive", step: "work_style" },
    { key: "response_style", label: "Response style", value: label(RESPONSE_STYLE_OPTIONS, a.responseStyle) || "Adaptive", step: "response_style" },
    { key: "memory", label: "Project memory", value: a.memory === false ? "Off" : "Enabled", step: "memory" },
    { key: "workspace", label: "Workspace", value: label(WORKSPACE_OPTIONS, a.workspace?.choice) || "—", step: "workspace" },
    { key: "github", label: "GitHub", value: extras.githubConnected || a.githubConnected ? "Connected" : "Not connected", step: "github" },
  ];
}

/** 0–4, with a message: length, mixed case, digits, symbols. */
export function passwordStrength(pw: string): { score: number; label: string; ok: boolean } {
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  const labels = ["Too short", "Weak", "Fair", "Good", "Strong"];
  return { score, label: pw.length < 8 ? "At least 8 characters" : labels[score]!, ok: pw.length >= 8 };
}

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ---- local draft (server unreachable) ----
const DRAFT_KEY = "orvyn:onboarding-draft";

export function saveDraft(draft: { step: Step; answers: Answers; completed: Step[] }, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(DRAFT_KEY, JSON.stringify({ ...draft, savedAt: Date.now() })); } catch { /* private mode */ }
}

export function loadDraft(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): { step: Step; answers: Answers; completed: Step[]; savedAt: number } | null {
  try {
    const raw = storage?.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearDraft(storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage): void {
  try { storage?.removeItem(DRAFT_KEY); } catch { /* ignore */ }
}

/** A draft newer than the server's profile wins for answers (then syncs); the server wins otherwise. */
export function mergeDraft(profile: Profile, draft: ReturnType<typeof loadDraft>): { step: Step; answers: Answers; completed: Step[]; needsSync: boolean } {
  if (!draft || draft.savedAt <= profile.updatedAt) return { step: profile.currentStep, answers: profile.answers, completed: profile.completedSteps, needsSync: false };
  const serverAt = STEPS.indexOf(profile.currentStep);
  const draftAt = STEPS.indexOf(draft.step);
  // Never jump past a step the server has not unlocked (verification/provisioning).
  const step = serverAt <= STEPS.indexOf("provisioning") ? profile.currentStep : draftAt > serverAt ? draft.step : profile.currentStep;
  return { step, answers: { ...profile.answers, ...draft.answers }, completed: [...new Set([...profile.completedSteps, ...draft.completed])], needsSync: true };
}

// ---------- the account gate ----------
//
// ORVYN opens only for a signed-in account whose onboarding is finished. There
// is no Skip and no anonymous local mode: a new person creates an account (or
// signs in), verifies their email, and completes setup first.

export type GateState = "checking" | "new" | "resume" | "offline" | "off";
export type GateServer = "complete" | "incomplete" | "unauthorized" | "unreachable";

export function decideGate(i: { bypassed: boolean; hasSession: boolean; server?: GateServer; cachedComplete: boolean }): GateState {
  if (i.bypassed) return "off";
  if (!i.hasSession) return "new";
  switch (i.server) {
    case "complete": return "off";
    case "incomplete": return "resume";
    case "unauthorized": return "new";
    // Offline: an account already known to have finished setup on this
    // machine may open (its work is local too); anyone else waits for the server.
    case "unreachable": return i.cachedComplete ? "off" : "offline";
    default: return "checking";
  }
}

/**
 * A connection-state change while ORVYN is open: leaving "signed-in" (sign
 * out, or the session expired) returns to the gate. Only the transition
 * counts: the startup "signed-out" before the session is validated does not.
 */
export function gateAfterAccountChange(current: GateState, previous: string | null, accountState: string, bypassed: boolean): GateState {
  if (bypassed || current !== "off" || previous !== "signed-in") return current;
  return accountState === "signed-out" || accountState === "expired" ? "new" : current;
}

const COMPLETE_KEY = "orvyn:onboarding-complete";

/** Remember (per account) that setup finished, so an offline launch can still open. */
export function rememberComplete(userKey: string, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(COMPLETE_KEY, userKey); } catch { /* storage off */ }
}
export function isRememberedComplete(userKey: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try { return Boolean(userKey) && storage?.getItem(COMPLETE_KEY) === userKey; } catch { return false; }
}
export function forgetComplete(storage: Pick<Storage, "removeItem"> | undefined = globalThis.localStorage): void {
  try { storage?.removeItem(COMPLETE_KEY); } catch { /* storage off */ }
}
