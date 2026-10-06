import { onboardingStore } from "../auth/AsyncAccountStores";
import { asyncHandler } from "../http/asyncHandler";
// apps/backend/src/routes/onboarding.ts
//
// The onboarding state machine over HTTP. Web and desktop call the same
// endpoints with the same session, so a user who starts on one continues on
// the other at the same step. Mounted before the tenant resolver (it
// authenticates the session itself, like /auth/me).

import { onAdminHost } from "../http/hosts";
import { Router, type Request, type Response } from "express";
import { authService } from "../auth/AsyncAuthService";
import { creditLedger } from "../billing/creditLedgerInstance";
import { PLANS, planById, CREDIT_PACKS } from "../billing/plans";
import { ANALYTICS_EVENTS, ONBOARDING_STEPS, isStep, sanitizeAnswers, type OnboardingStep } from "../onboarding/OnboardingStore";
import { provisionAccount, provisioningStatus, verificationRequired } from "../onboarding/provisioning";
import { applyPreferences } from "../onboarding/applyPreferences";
import { githubConnection } from "../integrations/githubConnection";

export const onboardingRouter = Router();

async function session(req: Request) {
  const header = req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  return token ? (await authService.verifyPrincipal(token)) : null;
}

const index = (s: OnboardingStep) => ONBOARDING_STEPS.indexOf(s);

/** The profile, creating it for an account that existed before onboarding ("finish setup"). */
async function profileFor(userId: string) {
  const store = onboardingStore();
  let profile = (await store.get(userId));
  if (!profile) {
    // Existing account: never asked to sign up or verify again.
    (await authService.markEmailVerified(userId));
    profile = (await store.ensure(userId, "provisioning", ["welcome", "signup", "verification"]));
    const name = (await authService.getUser(userId))?.name;
    if (name) profile = (await store.update(userId, { answers: { name } }));
  }
  return profile;
}

async function view(userId: string) {
  const profile = (await profileFor(userId));
  const user = (await authService.getUser(userId))!;
  const tenantId = (await authService.listOrganizations(userId)).find((o) => o.kind === "personal")?.tenantId ?? "";
  const planId = tenantId ? creditLedger.planOf(tenantId) : null;
  return {
    profile,
    steps: ONBOARDING_STEPS,
    user: { id: user.id, email: user.email, name: user.name, emailVerified: (await authService.isEmailVerified(userId)) },
    verificationRequired: verificationRequired(),
    provisioning: (await provisioningStatus(userId)),
    plan: planId ? publicPlan(planById(planId)) : null,
  };
}

function publicPlan(p: (typeof PLANS)[keyof typeof PLANS]) {
  return {
    id: p.id, label: p.label, priceMonthlyUsd: p.priceMonthlyUsd, priceAnnualUsd: p.priceAnnualUsd,
    monthlyCredits: p.monthlyCredits, rolling5h: p.rolling5h, rolling7d: p.rolling7d,
    parallelAgents: p.concurrentRuns, projects: p.projects, features: p.features, public: p.public,
  };
}

onboardingRouter.get("/", asyncHandler(async (req, res) => {
  const s = (await session(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  res.json((await view(s.user.id)));
}));

/** Save answers and move to a step. Steps after verification need a verified email. */
onboardingRouter.put("/", asyncHandler(async (req: Request, res: Response) => {
  const s = (await session(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  const userId = s.user.id;
  const current = (await profileFor(userId));
  const step = isStep(req.body?.step) ? (req.body.step as OnboardingStep) : undefined;
  const completed = Array.isArray(req.body?.completed) ? (req.body.completed as unknown[]).filter(isStep) : [];
  const answers = sanitizeAnswers(req.body?.answers);
  if (step && index(step) > index("verification") && verificationRequired() && !(await authService.isEmailVerified(userId))) {
    return res.status(409).json({ error: "Verify your email first.", code: "EMAIL_NOT_VERIFIED", ...(await view(userId)) });
  }
  if (step && index(step) > index("provisioning") && (await provisioningStatus(userId)).some((p) => !p.done)) {
    return res.status(409).json({ error: "Your workspace is still being set up.", code: "NOT_PROVISIONED", ...(await view(userId)) });
  }
  try {
    if (answers.name) (await authService.setName(userId, answers.name));
  } catch { /* the name stays in the answers */ }
  const updated = (await onboardingStore().update(userId, { step, completed, answers }));
  try {
    (await applyPreferences(userId, updated.answers));
  } catch { /* preferences apply on the next save */ }
  for (const c of completed) if (!current.completedSteps.includes(c)) (await onboardingStore().track(userId, "onboarding_step_completed", { step: c }));
  if (step && step !== current.currentStep) (await onboardingStore().track(userId, "onboarding_step_viewed", { step }));
  if (step === "complete" && !current.completedAt) (await onboardingStore().track(userId, "onboarding_completed"));
  res.json({ ...(await view(userId)), profile: updated });
}));

/** Runs the account bootstrap (idempotent) and reports the real state of each step. */
onboardingRouter.post("/provision", asyncHandler(async (req, res) => {
  const s = (await session(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  const steps = (await provisionAccount(s.user.id));
  const profile = (await onboardingStore().get(s.user.id));
  if (steps.every((p) => p.done) && profile && index(profile.currentStep) <= index("provisioning")) {
    (await onboardingStore().update(s.user.id, { step: "name", completed: ["verification", "provisioning"] }));
  }
  res.json((await view(s.user.id)));
}));

onboardingRouter.post("/event", asyncHandler(async (req, res) => {
  const s = (await session(req));
  const name = String(req.body?.name ?? "");
  if (!ANALYTICS_EVENTS.has(name)) return res.status(400).json({ error: "Unknown event" });
  (await onboardingStore().track(s?.user.id ?? null, name, (req.body?.props ?? {}) as Record<string, string | number | boolean>));
  res.json({ ok: true });
}));

/** Whether this account has connected GitHub (repository access). */
onboardingRouter.get("/github", asyncHandler(async (req, res) => {
  const s = (await session(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  res.json((await githubConnection(s.user.id)));
}));

/** Public plan list for the pricing screens (from the billing configuration). */
onboardingRouter.get("/plans", (_req, res) => {
  res.json({
    plans: Object.values(PLANS).filter((p) => p.public).map(publicPlan),
    packs: CREDIT_PACKS,
    annualSavings: "Save ~2 months",
  });
});

/** Which sign-in and billing integrations this server has keys for (buttons show only when real). */
onboardingRouter.get("/providers", (req, res) => {
  const has = (...names: string[]) => names.every((n) => Boolean(process.env[n]?.trim()));
  // Staff sign in to the Admin Portal with email and password (provider callbacks return to the customer host).
  const admin = onAdminHost(req);
  res.json({
    email: verificationRequired(),
    google: !admin && has("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
    github: !admin && has("GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"),
    termsUrl: process.env.ORVYN_TERMS_URL?.trim() || null,
    privacyUrl: process.env.ORVYN_PRIVACY_URL?.trim() || null,
    checkout: has("STRIPE_SECRET_KEY"),
  });
});
