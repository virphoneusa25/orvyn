// apps/backend/src/onboarding/provisioning.ts
//
// Account bootstrap after signup (and email verification), idempotent and
// server-side. Each checklist line on the "Setting up your workspace…"
// screen is the result of checking the real system, never a timer:
//
//   account    the user row exists (and its email is verified, when required)
//   workspace  the Personal Organization and its tenant exist
//   plan       the credit wallet exists on a plan (Free for new accounts)
//   credits    the ledger has issued the plan's monthly credits
//   orion      the tenant's engine is loaded and ORION's preferences are set
//
// Running it twice issues nothing twice: the wallet grant happens once when
// the wallet is created (CreditLedger.ensureAccount).

import { authService } from "../auth/AuthService";
import { creditLedger } from "../billing/creditLedgerInstance";
import { DEFAULT_PLAN, planById } from "../billing/plans";
import { tenantManager } from "../tenancy/TenantManager";
import { onboardingStore } from "./OnboardingStore";

export type ProvisionStepId = "account" | "workspace" | "plan" | "credits" | "orion";
export interface ProvisionStep { id: ProvisionStepId; label: string; done: boolean; detail?: string }

export const PROVISION_LABELS: Record<ProvisionStepId, string> = {
  account: "Creating your account",
  workspace: "Setting up your workspace",
  plan: "Provisioning your Free plan",
  credits: "Adding your credits",
  orion: "Preparing ORION",
};

/** Is email verification required before provisioning? (Only when this server can send email.) */
export function verificationRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.ORVYN_REQUIRE_EMAIL_VERIFICATION === "false") return false;
  return Boolean(env.ORVYN_MAIL_CAPTURE?.trim() || (env.SMTP_HOST?.trim() && env.SMTP_USER?.trim() && env.SMTP_PASS));
}

/** Reads the real state of each step (no side effects). */
export function provisioningStatus(userId: string): ProvisionStep[] {
  const user = authService.getUser(userId);
  const orgs = user ? authService.listOrganizations(userId) : [];
  const personal = orgs.find((o) => o.kind === "personal");
  const tenantId = personal?.tenantId ?? "";
  const plan = tenantId ? creditLedger.planOf(tenantId) : null;
  const grants = tenantId ? creditLedger.grantsIssued(tenantId) : [];
  const tenant = tenantId ? tenantManager.get(tenantId) : undefined;
  const profile = onboardingStore().get(userId);
  const verified = user ? (authService.isEmailVerified(userId) || !verificationRequired()) : false;
  const planLabel = plan ? planById(plan).label : planById(DEFAULT_PLAN).label;
  return [
    { id: "account", label: PROVISION_LABELS.account, done: Boolean(user) && verified },
    { id: "workspace", label: PROVISION_LABELS.workspace, done: Boolean(personal) && Boolean(tenant) },
    { id: "plan", label: `Provisioning your ${planLabel} plan`, done: Boolean(plan) },
    { id: "credits", label: PROVISION_LABELS.credits, done: grants.length > 0, detail: grants.length ? `${grants[grants.length - 1]!.credits.toLocaleString("en-US")} credits` : undefined },
    { id: "orion", label: PROVISION_LABELS.orion, done: Boolean(tenant) && Boolean(profile) },
  ];
}

/** Performs each missing step in order; stops at the first one that cannot run yet. */
export function provisionAccount(userId: string): ProvisionStep[] {
  const user = authService.getUser(userId);
  if (!user) return provisioningStatus(userId);
  if (verificationRequired() && !authService.isEmailVerified(userId)) return provisioningStatus(userId);
  const org = authService.ensurePersonalOrganization(user);
  tenantManager.ensureUserTenant(userId, org.name || user.email);
  // The wallet is created on the Free plan with its monthly credits exactly once.
  if (!creditLedger.planOf(org.tenantId)) creditLedger.ensureAccount(org.tenantId, DEFAULT_PLAN);
  onboardingStore().ensure(userId, "name");
  return provisioningStatus(userId);
}
