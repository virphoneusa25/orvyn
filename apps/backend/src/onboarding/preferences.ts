// apps/backend/src/onboarding/preferences.ts
//
// What the user chose in onboarding, applied to ORION. The choices are kept
// in the user's tenant settings ("orion.preferences") so every run and chat
// of that workspace reads them without another lookup.

import type { OnboardingAnswers } from "./OnboardingStore";

export const PREFERENCES_KEY = "orion.preferences";

export interface OrionPreferences {
  name?: string;
  workStyle?: OnboardingAnswers["workStyle"];
  responseStyle?: OnboardingAnswers["responseStyle"];
  memory?: boolean;
  primaryUse?: OnboardingAnswers["primaryUse"];
  goals?: OnboardingAnswers["goals"];
}

export interface SettingsLike { getSetting?(key: string): string | null; setSetting?(key: string, value: string): void }

export function readPreferences(store: unknown): OrionPreferences {
  try {
    const raw = (store as SettingsLike | undefined)?.getSetting?.(PREFERENCES_KEY);
    return raw ? (JSON.parse(raw) as OrionPreferences) : {};
  } catch {
    return {};
  }
}

/** Project Memory is on unless the user turned it off. */
export function memoryEnabled(store: unknown): boolean {
  return readPreferences(store).memory !== false;
}

const WORK: Record<string, string> = {
  plan_first: "Before major work, show a short plan and keep progress visible as you go.",
  move_fast: "Start executing quickly; adapt as the work develops. Do not stop to present plans for routine work.",
  adaptive: "Choose per task: plan first for large or risky work, act directly on small tasks.",
};
const RESPONSE: Record<string, string> = {
  concise: "Keep replies short and direct.",
  balanced: "Keep replies clear and helpful, with the key details.",
  detailed: "Give in-depth explanations when you reply.",
  adaptive: "Size each reply to the task.",
};
const USES: Record<string, string> = {
  software: "software development", devops: "servers and DevOps", research: "research", business: "business and operations",
  automation: "automation", everything: "a bit of everything",
};

/** A few lines for ORION's system prompt; empty when nothing was chosen. */
export function preferencesPrompt(store: unknown): string {
  const p = readPreferences(store);
  const lines: string[] = [];
  if (p.name) lines.push(`The user's name is ${p.name}; address them by it when natural.`);
  if (p.workStyle && WORK[p.workStyle]) lines.push(`Work style: ${WORK[p.workStyle]}`);
  if (p.responseStyle && RESPONSE[p.responseStyle]) lines.push(`Response style: ${RESPONSE[p.responseStyle]}`);
  if (p.primaryUse?.length) lines.push(`They mainly use ORVYN for ${p.primaryUse.map((u) => USES[u] ?? u).join(", ")}.`);
  return lines.length ? `User preferences (from onboarding):\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}


export interface AsyncSettingsLike {
  getSetting?(key: string): string | null | Promise<string | null>;
}

/** Storage failures propagate; unavailable privacy preferences never default to learning. */
export async function readPreferencesAsync(store: unknown): Promise<OrionPreferences> {
  const raw = await (store as AsyncSettingsLike | undefined)?.getSetting?.(PREFERENCES_KEY);
  if (!raw) return {};
  try { const parsed = JSON.parse(raw); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}

export async function memoryEnabledAsync(store: unknown): Promise<boolean> {
  return (await readPreferencesAsync(store)).memory !== false;
}

export async function preferencesPromptAsync(store: unknown): Promise<string> {
  const preferences = await readPreferencesAsync(store);
  return preferencesPrompt({ getSetting: () => JSON.stringify(preferences) });
}
