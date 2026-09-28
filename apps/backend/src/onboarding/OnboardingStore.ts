// apps/backend/src/onboarding/OnboardingStore.ts
//
// The onboarding state machine, stored server-side (auth.db) so web and
// desktop resume at the same step. One profile per user.
//
//   welcome → signup → verification → provisioning → name → primary_use →
//   goals → work_style → response_style → memory → workspace → github →
//   plan → recap → first_mission → complete
//
// Answers are the user's choices (name, uses, goals, work style, response
// style, memory, workspace, first mission). Preferences derived from them
// shape ORION (see preferences.ts). Analytics events never carry passwords,
// tokens or free-text content.

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { defaultDataDir } from "../persistence/LocalStore";

export const ONBOARDING_STEPS = [
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
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const PRIMARY_USES = ["software", "devops", "research", "business", "automation", "everything"] as const;
export const GOALS = ["build_software", "servers_deployments", "research", "automate", "websites_apps", "analyze_data", "other"] as const;
export const WORK_STYLES = ["plan_first", "move_fast", "adaptive"] as const;
export const RESPONSE_STYLES = ["concise", "balanced", "detailed", "adaptive"] as const;
export const WORKSPACE_CHOICES = ["new_project", "local_folder", "clone_repo", "github", "none"] as const;

export interface OnboardingAnswers {
  name?: string;
  primaryUse?: (typeof PRIMARY_USES)[number][];
  goals?: (typeof GOALS)[number][];
  goalOther?: string;
  workStyle?: (typeof WORK_STYLES)[number];
  responseStyle?: (typeof RESPONSE_STYLES)[number];
  memory?: boolean;
  workspace?: { choice: (typeof WORKSPACE_CHOICES)[number]; path?: string; repoUrl?: string; projectName?: string };
  githubConnected?: boolean;
  firstMission?: string;
}

export interface OnboardingProfile {
  id: string;
  userId: string;
  currentStep: OnboardingStep;
  completedSteps: OnboardingStep[];
  answers: OnboardingAnswers;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export const ANALYTICS_EVENTS = new Set([
  "signup_started", "signup_completed", "email_verified", "onboarding_started", "onboarding_step_viewed",
  "onboarding_step_completed", "onboarding_completed", "first_mission_started", "first_mission_completed",
  "upgrade_viewed", "checkout_started", "subscription_activated",
]);

export function isStep(value: unknown): value is OnboardingStep {
  return typeof value === "string" && (ONBOARDING_STEPS as readonly string[]).includes(value);
}

const pickMany = <T extends string>(allowed: readonly T[], v: unknown): T[] | undefined =>
  Array.isArray(v) ? [...new Set(v.filter((x): x is T => typeof x === "string" && (allowed as readonly string[]).includes(x)))] : undefined;
const pickOne = <T extends string>(allowed: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : undefined;

/** Only known answer fields, with known values, survive. */
export function sanitizeAnswers(input: unknown): OnboardingAnswers {
  const a = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const out: OnboardingAnswers = {};
  if (typeof a.name === "string" && a.name.trim()) out.name = a.name.trim().slice(0, 80);
  const uses = pickMany(PRIMARY_USES, a.primaryUse);
  if (uses) out.primaryUse = uses;
  const goals = pickMany(GOALS, a.goals);
  if (goals) out.goals = goals;
  if (typeof a.goalOther === "string") out.goalOther = a.goalOther.trim().slice(0, 300);
  const ws = pickOne(WORK_STYLES, a.workStyle);
  if (ws) out.workStyle = ws;
  const rs = pickOne(RESPONSE_STYLES, a.responseStyle);
  if (rs) out.responseStyle = rs;
  if (typeof a.memory === "boolean") out.memory = a.memory;
  if (a.workspace && typeof a.workspace === "object") {
    const w = a.workspace as Record<string, unknown>;
    const choice = pickOne(WORKSPACE_CHOICES, w.choice);
    if (choice) {
      out.workspace = { choice };
      if (typeof w.path === "string" && w.path.trim()) out.workspace.path = w.path.trim().slice(0, 1000);
      if (typeof w.repoUrl === "string" && w.repoUrl.trim()) out.workspace.repoUrl = w.repoUrl.trim().slice(0, 500);
      if (typeof w.projectName === "string" && w.projectName.trim()) out.workspace.projectName = w.projectName.trim().slice(0, 120);
    }
  }
  if (typeof a.firstMission === "string") out.firstMission = a.firstMission.slice(0, 60);
  return out;
}

export class OnboardingStore {
  private db: DatabaseSync;

  constructor(dataDir: string = defaultDataDir()) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "auth.db"));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS onboarding_profiles (
        user_id TEXT PRIMARY KEY,
        id TEXT NOT NULL,
        current_step TEXT NOT NULL,
        completed_steps TEXT NOT NULL,
        answers TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        name TEXT NOT NULL,
        props TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_analytics_name ON analytics_events (name, created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  get(userId: string): OnboardingProfile | null {
    const row = this.db.prepare(`SELECT * FROM onboarding_profiles WHERE user_id = ?`).get(userId) as any;
    return row ? toProfile(row) : null;
  }

  /** Creates the profile once (idempotent). A new signup starts at verification; an existing account at "name" (finish setup). */
  ensure(userId: string, start: OnboardingStep, completed: OnboardingStep[] = [], now = Date.now()): OnboardingProfile {
    const existing = this.get(userId);
    if (existing) return existing;
    this.db
      .prepare(`INSERT INTO onboarding_profiles (user_id, id, current_step, completed_steps, answers, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, '{}', ?, ?, NULL)`)
      .run(userId, `onb_${randomUUID()}`, start, JSON.stringify(completed), now, now);
    return this.get(userId)!;
  }

  /** Saves answers (merged) and moves to `step`. `completed` marks steps done. */
  update(userId: string, patch: { step?: OnboardingStep; completed?: OnboardingStep[]; answers?: OnboardingAnswers }, now = Date.now()): OnboardingProfile {
    const cur = this.get(userId) ?? this.ensure(userId, "name", [], now);
    const answers = { ...cur.answers, ...(patch.answers ?? {}) };
    const done = new Set<OnboardingStep>([...cur.completedSteps, ...(patch.completed ?? [])]);
    const step = patch.step ?? cur.currentStep;
    const completedAt = step === "complete" ? (cur.completedAt ?? now) : cur.completedAt;
    if (step === "complete") done.add("first_mission");
    const ordered = ONBOARDING_STEPS.filter((s) => done.has(s));
    this.db
      .prepare(`UPDATE onboarding_profiles SET current_step = ?, completed_steps = ?, answers = ?, updated_at = ?, completed_at = ? WHERE user_id = ?`)
      .run(step, JSON.stringify(ordered), JSON.stringify(answers), now, completedAt, userId);
    return this.get(userId)!;
  }

  track(userId: string | null, name: string, props: Record<string, string | number | boolean> = {}, now = Date.now()): void {
    if (!ANALYTICS_EVENTS.has(name)) return;
    // Only short scalar properties (step names, plan ids, choices): never free text, tokens or passwords.
    const safe: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(props).slice(0, 12)) {
      if (/pass|token|secret|code|content|text|email/i.test(k)) continue;
      if (typeof v === "string") safe[k] = v.slice(0, 64);
      else if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    }
    this.db.prepare(`INSERT INTO analytics_events (id, user_id, name, props, created_at) VALUES (?, ?, ?, ?, ?)`).run(`evt_${randomUUID()}`, userId, name, JSON.stringify(safe), now);
  }

  events(name?: string): { userId: string | null; name: string; props: Record<string, unknown>; createdAt: number }[] {
    const rows = (name
      ? this.db.prepare(`SELECT * FROM analytics_events WHERE name = ? ORDER BY created_at`).all(name)
      : this.db.prepare(`SELECT * FROM analytics_events ORDER BY created_at`).all()) as any[];
    return rows.map((r) => ({ userId: r.user_id ?? null, name: String(r.name), props: JSON.parse(String(r.props)), createdAt: Number(r.created_at) }));
  }
}

function toProfile(row: any): OnboardingProfile {
  return {
    id: String(row.id),
    userId: String(row.user_id),
    currentStep: isStep(row.current_step) ? row.current_step : "name",
    completedSteps: (JSON.parse(String(row.completed_steps || "[]")) as unknown[]).filter(isStep),
    answers: sanitizeAnswers(JSON.parse(String(row.answers || "{}"))),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    completedAt: row.completed_at != null ? Number(row.completed_at) : null,
  };
}

let shared: OnboardingStore | null = null;
export function onboardingStore(): OnboardingStore {
  if (!shared) shared = new OnboardingStore();
  return shared;
}
