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
import { authService } from "../auth/AuthService";
import { onboardingStore } from "../onboarding/OnboardingStore";
import { verificationRequired } from "../onboarding/provisioning";

export type AccountReadiness = "ready" | "EMAIL_NOT_VERIFIED" | "ONBOARDING_REQUIRED";

export function accountGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORVYN_CLOUD_MODE === "true" && env.ORVYN_REQUIRE_ONBOARDING !== "false";
}

export function accountReadiness(userId: string): AccountReadiness {
  if (verificationRequired() && !authService.isEmailVerified(userId)) return "EMAIL_NOT_VERIFIED";
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

export function requireAccountReady(req: Request, res: Response, next: NextFunction): void {
  const userId = req.principal?.userId;
  if (!userId || !accountGateEnabled() || gateExempt(req.method, req.path)) return next();
  const state = accountReadiness(userId);
  if (state === "ready") return next();
  if (state === "ONBOARDING_REQUIRED" && req.method === "POST" && OPEN_DURING_SETUP.some((r) => r.test(req.path))) return next();
  res.status(403).json({ error: MESSAGE[state], code: state });
}

/** Same rule for the chat WebSocket (session tokens only). */
export function socketAccountReady(token: string | null): { ok: true } | { ok: false; error: string; code: AccountReadiness } {
  if (!token || !accountGateEnabled()) return { ok: true };
  const session = authService.verifyPrincipal(token);
  if (!session) return { ok: true }; // API keys and invalid tokens are handled by authorizeSocket
  const state = accountReadiness(session.user.id);
  return state === "ready" ? { ok: true } : { ok: false, error: MESSAGE[state], code: state };
}
