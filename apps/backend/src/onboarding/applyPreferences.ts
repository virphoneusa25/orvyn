// apps/backend/src/onboarding/applyPreferences.ts
import { authService } from "../auth/AuthService";
import { tenantManager } from "../tenancy/TenantManager";
import type { OnboardingAnswers } from "./OnboardingStore";
import { PREFERENCES_KEY, type OrionPreferences, type SettingsLike } from "./preferences";

/** Writes the onboarding choices into the user's personal tenant settings. */
export function applyPreferences(userId: string, answers: OnboardingAnswers): void {
  const org = authService.listOrganizations(userId).find((o) => o.kind === "personal");
  if (!org) return;
  const tenant = tenantManager.ensureUserTenant(userId, org.name);
  const prefs: OrionPreferences = {
    name: answers.name,
    workStyle: answers.workStyle,
    responseStyle: answers.responseStyle,
    memory: answers.memory,
    primaryUse: answers.primaryUse,
    goals: answers.goals,
  };
  (tenant.localStore as unknown as SettingsLike).setSetting?.(PREFERENCES_KEY, JSON.stringify(prefs));
}

