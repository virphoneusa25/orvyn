// apps/backend/src/routes/auth.ts
//
// Account endpoints. Mounted BEFORE the tenant resolver in index.ts:
// register/login must be reachable without credentials, and me/logout
// authenticate directly against the session store (they don't need a tenant).

import { Router, Request } from "express";
import { authService } from "../auth/AuthService";
import { onboardingStore } from "../onboarding/OnboardingStore";
import { verificationRequired } from "../onboarding/provisioning";
import { mailConfigured, sendMail, verificationMail } from "../onboarding/mailer";

/** Public origin for links in email (the address the user reached us at). */
function publicOrigin(req: Request): string {
  const fixed = process.env.ORVYN_PUBLIC_ORIGIN?.trim();
  if (fixed) return fixed.replace(/\/$/, "");
  const proto = String(req.header("x-forwarded-proto") || req.protocol || "https").split(",")[0]!.trim();
  const host = String(req.header("x-forwarded-host") || req.get("host") || "").split(",")[0]!.trim();
  return `${proto}://${host}`;
}

const lastSent = new Map<string, number>();

/** Sends (or re-sends) the verification link. At most one email a minute per account. */
async function sendVerification(req: Request, userId: string, name: string | null): Promise<{ sent: boolean; error?: string }> {
  if (!mailConfigured()) return { sent: false, error: "Email is not configured on this server." };
  const prev = lastSent.get(userId) ?? 0;
  if (Date.now() - prev < 60_000) return { sent: false, error: "A verification email was just sent. Check your inbox (and spam), or try again in a minute." };
  lastSent.set(userId, Date.now());
  const { token, email } = authService.createEmailVerification(userId);
  const link = `${publicOrigin(req)}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;
  try {
    await sendMail(verificationMail({ to: email, name, link }));
    return { sent: true };
  } catch (err: any) {
    lastSent.delete(userId);
    console.warn(JSON.stringify({ event: "auth.verification.send_failed", error: String(err?.code ?? err?.message ?? err).slice(0, 80) }));
    return { sent: false, error: "The verification email could not be sent. Try again in a moment." };
  }
}

export const authRouter = Router();

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

authRouter.post("/register", async (req, res) => {
  try {
    const { user, token, organization } = authService.register(
      String(req.body.email ?? ""),
      String(req.body.password ?? ""),
      req.body.name ? String(req.body.name) : undefined
    );
    const session = authService.verifyPrincipal(token);
    // A new account starts onboarding at email verification (or straight at
    // provisioning when this server cannot send email).
    const required = verificationRequired();
    onboardingStore().ensure(user.id, required ? "verification" : "provisioning", ["welcome", "signup"]);
    if (user.name) onboardingStore().update(user.id, { answers: { name: user.name } });
    onboardingStore().track(user.id, "signup_completed", { method: "email" });
    const verification = required ? await sendVerification(req, user.id, user.name) : { sent: false };
    res.status(201).json({
      user,
      token,
      organization,
      principal: session?.principal ?? null,
      verification: { required, ...verification },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

/** The link in the verification email. Opens in the browser; ORVYN notices on its own. */
authRouter.get("/verify", (req, res) => {
  const user = authService.verifyEmailToken(String(req.query.token ?? ""));
  if (user) {
    onboardingStore().track(user.id, "email_verified");
    const profile = onboardingStore().get(user.id);
    if (profile && profile.currentStep === "verification") onboardingStore().update(user.id, { step: "provisioning", completed: ["verification"] });
  }
  res.status(user ? 200 : 400).type("html").send(verifiedPage(Boolean(user)));
});

authRouter.get("/verification/status", (req, res) => {
  const token = bearerToken(req);
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  res.json({ email: session.user.email, verified: authService.isEmailVerified(session.user.id), required: verificationRequired() });
});

authRouter.post("/verification/resend", async (req, res) => {
  const token = bearerToken(req);
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  if (authService.isEmailVerified(session.user.id)) return res.json({ sent: false, verified: true });
  const out = await sendVerification(req, session.user.id, session.user.name);
  res.status(out.sent ? 200 : 429).json(out);
});

authRouter.post("/verification/change-email", async (req, res) => {
  const token = bearerToken(req);
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  try {
    const user = authService.changeUnverifiedEmail(session.user.id, String(req.body?.email ?? ""));
    lastSent.delete(user.id);
    const out = await sendVerification(req, user.id, user.name);
    res.json({ email: user.email, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

authRouter.post("/login", (req, res) => {
  try {
    const { user, token, organization } = authService.login(String(req.body.email ?? ""), String(req.body.password ?? ""));
    const session = authService.verifyPrincipal(token);
    res.json({
      user,
      token,
      organization,
      principal: session?.principal ?? null,
    });
  } catch (err: any) {
    // 429 for lockout, 401 for bad credentials.
    const status = err.message.startsWith("Too many") ? 429 : 401;
    res.status(status).json({ error: err.message });
  }
});

authRouter.post("/logout", (req, res) => {
  const token = bearerToken(req);
  if (token) authService.logout(token);
  res.json({ ok: true });
});

authRouter.post("/switch-organization", (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const switched = authService.switchOrganization(token, String(req.body.organizationId ?? ""));
    res.json(switched);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message === "Not found" ? "Not found" : err.message });
  }
});

authRouter.get("/me", (req, res) => {
  const token = bearerToken(req);
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  const profile = onboardingStore().get(session.user.id);
  res.json({
    user: { ...session.user, emailVerified: authService.isEmailVerified(session.user.id) },
    principal: session.principal,
    organizations: authService.listOrganizations(session.user.id),
    onboarding: profile ? { step: profile.currentStep, completedAt: profile.completedAt } : null,
  });
});

function verifiedPage(ok: boolean): string {
  const title = ok ? "Email verified" : "This link has expired";
  const body = ok
    ? "Your ORVYN account is confirmed. Go back to ORVYN: it continues on its own."
    : "Open ORVYN and choose Resend email to get a new link.";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · ORVYN</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#1a1045 0%,#050816 60%);font-family:Inter,Segoe UI,Arial,sans-serif;color:#F8FAFF">
<main style="text-align:center;padding:32px;max-width:420px">
<div style="width:96px;height:96px;margin:0 auto 24px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#f0c8ff 0%,#C044FF 35%,#7C4DFF 60%,#22D3EE 100%);box-shadow:0 0 60px rgba(124,77,255,.6)"></div>
<h1 style="font-size:24px;margin:0 0 10px">${title}</h1><p style="color:#9DAAC7;line-height:1.6">${body}</p></main></body></html>`;
}
