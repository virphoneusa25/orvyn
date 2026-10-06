// apps/backend/src/middleware/accountReady.ts
//
// The server half of the account gate. On ORVYN Cloud a signed-in person
// can use ORVYN (runs, chat, projects, files, tools) only once their email
// is verified (when this server sends mail) and onboarding is finished.
// The desktop and the web app enforce the same rule in their UI, but a
// client can be modified — this is the check that holds.
//
// Outside the gate: /auth and /onboarding (mounted before this), the worker
// channels (they execute runs; no run can exist for an unready account) and
// read-only account/billing status used by the setup screens.
// API keys (server-to-server) are not people and are not gated here.

import type { NextFunction, Request, Response } from "express";
import { authService } from "../auth/AsyncAuthService";
import { staffStore } from "../admin/staffStore";
import { onboardingStore } from "../onboarding/OnboardingStore";
import { verificationRequired } from "../onboarding/provisioning";

export type AccountReadiness = "ready" | "EMAIL_NOT_VERIFIED" | "ONBOARDING_REQUIRED";

export function accountGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVYN_CLOUD_MODE === "true" && env.ORVYN_REQUIRE_ONBOARDING !== "false";
}

export async function accountReadiness(userId: string): Promise<AccountReadiness> {
  if (verificationRequired() && !(await authService.isEmailVerified(userId))) return "EMAIL_NOT_VERIFIED";
  if (!onboardingStore().get(userId)?.completedAt) return "ONBOARDING_REQUIRED";
  return "ready";
}

const OPEN_ANY = [/^\/local-worker(\/|$)/, /^\/worker(\/|$)/];
const OPEN_GET = [/^\/session$/, /^\/billing\/?$/, /^\/health$/];
/** Open to a verified account that is still in setup (the plan step can start Checkout). */
const OPEN_DURING_SETUP = [/^\/billing\/checkout$/];

export function gateExempt(method: string, path: string): boolean {
  if (OPEN_ANY.some((r) => r.test(path))) return true;
  return method === "GET" && OPEN_GET.some((r) => r.test(path));
}

const MESSAGE: Record<Exclude<AccountReadiness, "ready">, string> = {
  EMAIL_NOT_VERIFIED: "Verify your email to start using ORVYN.",
  ONBOARDING_REQUIRED: "Finish setting up your ORVYN account to continue.",
};

/** A paused account (staff action) can sign in but not use ORVYN; its data stays exactly as it was. */
export function pausedMessage(tenantId: string | undefined): string | null {
  if (!tenantId) return null;
  return staffStore().suspension(tenantId) ? "This account is paused. Contact ORVYN support to restore access." : null;
}

export async function requireAccountReady(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.principal && !(req as Request & { viewAs?: unknown }).viewAs && !OPEN_ANY.some((r) => r.test(req.path))) {
    const paused = pausedMessage(req.principal.tenantId);
    if (paused) { res.status(403).json({ error: paused, code: "ACCOUNT_PAUSED" }); return; }
  }
  const userId = req.principal?.userId;
  if (!userId || !accountGateEnabled() || gateExempt(req.method, req.path)) return next();
  const state = (await accountReadiness(userId));
  if (state === "ready") return next();
  if (state === "ONBOARDING_REQUIRED" && req.method === "POST" && OPEN_DURING_SETUP.some((r) => r.test(req.path))) return next();
  res.status(403).json({ error: MESSAGE[state], code: state });
}

/** Same rule for the chat WebSocket (session tokens only). */
export async function socketAccountReady(token: string | null): Promise<{ ok: true } | { ok: false; error: string; code: AccountReadiness }> {
  if (!token || !accountGateEnabled()) return { ok: true };
  const session = (await authService.verifyPrincipal(token));
  if (!session) return { ok: true }; // API keys and invalid tokens are handled by authorizeSocket
  const paused = pausedMessage(session.principal.tenantId);
  if (paused) return { ok: false, error: paused, code: "ACCOUNT_PAUSED" as AccountReadiness };
  const state = (await accountReadiness(session.user.id));
  return state === "ready" ? { ok: true } : { ok: false, error: MESSAGE[state], code: state };
}
