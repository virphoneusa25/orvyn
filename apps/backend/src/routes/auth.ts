import { staffStore, onboardingStore } from "../auth/AsyncAccountStores";
import { asyncHandler } from "../http/asyncHandler";
// apps/backend/src/routes/auth.ts
//
// Account endpoints. Mounted BEFORE the tenant resolver in index.ts:
// register/login must be reachable without credentials, and me/logout
// authenticate directly against the session store (they don't need a tenant).

import { Router, Request } from "express";

import { authService } from "../auth/AsyncAuthService";

import { verificationRequired } from "../onboarding/provisioning";
import { mailConfigured, passwordResetMail, securityNoticeMail, sendMail, verificationMail } from "../onboarding/mailer";
import { createHash, randomBytes } from "node:crypto";
import { authorizeUrl, exchangeCode, exchangeCodeWithToken, oauthConfigured, oauthProvider } from "../auth/oauthProviders";
import { saveGithubConnection } from "../integrations/githubConnection";
import { LEGAL_VERSION, publicLegalBundle } from "../legal/documents";

/** Public origin for links in email (the address the user reached us at). */
export function publicOrigin(req: Request): string {
  const fixed = process.env.ORVYN_PUBLIC_ORIGIN?.trim();
  if (fixed) return fixed.replace(/\/$/, "");
  const proto = String(req.header("x-forwarded-proto") || req.protocol || "https").split(",")[0]!.trim();
  const host = String(req.header("x-forwarded-host") || req.get("host") || "").split(",")[0]!.trim();
  return `${proto}://${host}`;
}

const lastSent = new Map<string, number>();

/** Sends (or re-sends) the verification link. At most one email a minute per account. */
export async function sendVerification(req: Request, userId: string, name: string | null): Promise<{ sent: boolean; error?: string }> {
  if (!mailConfigured()) return { sent: false, error: "Email is not configured on this server." };
  const prev = lastSent.get(userId) ?? 0;
  if (Date.now() - prev < 60_000) return { sent: false, error: "A verification email was just sent. Check your inbox (and spam), or try again in a minute." };
  lastSent.set(userId, Date.now());
  const { token, email } = (await authService.createEmailVerification(userId));
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

function deviceOf(req: Request): string {
  return String(req.body?.device ?? req.header("x-orvyn-device") ?? req.header("user-agent") ?? "");
}

async function sessionOf(req: Request) {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  return session ? { token: token!, ...session } : null;
}

async function notify(userId: string, subject: string, message: string): Promise<void> {
  const user = (await authService.getUser(userId));
  if (!user || !mailConfigured()) return;
  try { await sendMail(securityNoticeMail({ to: user.email, name: user.name, subject, message })); } catch { /* best effort */ }
}

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7);
  return null;
}

authRouter.post("/register", asyncHandler(async (req, res) => {
  // The web sign-up asks for a full name and agreement to the Terms (the desktop app collects its own).
  const web = req.body?.client === "web";
  if (web && String(req.body?.name ?? "").trim().split(/\s+/).filter(Boolean).length < 2) return res.status(400).json({ error: "Enter your first and last name." });
  if (web && (req.body?.legalAccepted !== true || String(req.body?.legalVersion ?? "") !== LEGAL_VERSION)) {
    return res.status(400).json({ error: "Review and accept the current ORVYN Software License, Privacy Policy, Acceptable Use Policy, and AI & Agent Disclosure to create an account.", code: "LEGAL_ACCEPTANCE_REQUIRED" });
  }
  try {
    const { user, token, organization } = (await authService.register(
      String(req.body.email ?? ""),
      String(req.body.password ?? ""),
      req.body.name ? String(req.body.name) : undefined,
      deviceOf(req),
    ));
    if (web) (await authService.acceptLegal(user.id, LEGAL_VERSION, "web-signup"));
    else if (req.body?.acceptTerms === true) (await authService.acceptTerms(user.id, Date.now(), String(req.body?.client ?? "client")));
    if (typeof req.body?.organization === "string" && req.body.organization.trim() && organization?.id) (await authService.nameOrganization(organization.id, req.body.organization));
    const session = (await authService.verifyPrincipal(token));
    // A new account starts onboarding at email verification (or straight at
    // provisioning when this server cannot send email).
    const required = verificationRequired();
    (await onboardingStore().ensure(user.id, required ? "verification" : "provisioning", ["welcome", "signup"]));
    if (user.name) (await onboardingStore().update(user.id, { answers: { name: user.name } }));
    (await onboardingStore().track(user.id, "signup_completed", { method: "email" }));
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
}));

/** The link in the verification email. Opens in the browser; ORVYN notices on its own. */
authRouter.get("/verify", asyncHandler(async (req, res) => {
  const user = (await authService.verifyEmailToken(String(req.query.token ?? "")));
  if (user) {
    (await onboardingStore().track(user.id, "email_verified"));
    const profile = (await onboardingStore().get(user.id));
    if (profile && profile.currentStep === "verification") (await onboardingStore().update(user.id, { step: "provisioning", completed: ["verification"] }));
  }
  res.status(user ? 200 : 400).type("html").send(verifiedPage(Boolean(user)));
}));

authRouter.get("/verification/status", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  res.json({ email: session.user.email, verified: (await authService.isEmailVerified(session.user.id)), required: verificationRequired() });
}));

authRouter.post("/verification/resend", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  if ((await authService.isEmailVerified(session.user.id))) return res.json({ sent: false, verified: true });
  const out = await sendVerification(req, session.user.id, session.user.name);
  res.status(out.sent ? 200 : 429).json(out);
}));

authRouter.post("/verification/change-email", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  try {
    const user = (await authService.changeUnverifiedEmail(session.user.id, String(req.body?.email ?? "")));
    lastSent.delete(user.id);
    const out = await sendVerification(req, user.id, user.name);
    res.json({ email: user.email, ...out });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

authRouter.post("/login", asyncHandler(async (req, res) => {
  try {
    const { user, token, organization } = (await authService.login(String(req.body.email ?? ""), String(req.body.password ?? ""), deviceOf(req)));
    const session = (await authService.verifyPrincipal(token));
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
}));

authRouter.post("/logout", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  if (token?.startsWith("orvview_")) {
    const view = (await staffStore().resolveViewAs(token));
    (await staffStore().endViewAs(token));
    if (view) (await staffStore().audit({ actorId: view.staffId, actorEmail: view.staffEmail, action: "support.view_as_end", tenantId: view.tenantId, ip: req.ip ?? null }));
    return res.json({ ok: true });
  }
  if (token) (await authService.logout(token));
  res.json({ ok: true });
}));

authRouter.post("/switch-organization", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: "Not signed in" });
  try {
    const switched = (await authService.switchOrganization(token, String(req.body.organizationId ?? "")));
    res.json(switched);
  } catch (err: any) {
    res.status(err.status ?? 400).json({ error: err.message === "Not found" ? "Not found" : err.message });
  }
}));

authRouter.get("/me", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  // Staff "View as customer" (read-only): the customer's view, labelled as a support session.
  const view = token?.startsWith("orvview_") ? (await staffStore().resolveViewAs(token)) : null;
  const session = view ? (await authService.principalFor(view.userId, view.organizationId)) : token ? (await authService.verifyPrincipal(token)) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  const profile = (await onboardingStore().get(session.user.id));
  if (!view && process.env.ORVYN_SUPER_ADMIN_EMAILS) (await staffStore().seedFromEnv());
  const paused = (await staffStore().suspension(session.principal.tenantId));
  res.json({
    user: { ...session.user, emailVerified: (await authService.isEmailVerified(session.user.id)) },
    principal: session.principal,
    organizations: (await authService.listOrganizations(session.user.id)),
    onboarding: profile ? { step: profile.currentStep, completedAt: profile.completedAt } : null,
    verificationRequired: verificationRequired(),
    staff: view ? null : (await (async () => { const role = (await staffStore().roleOf(session.user.id)); return role ? { role } : null; })()),
    paused: paused && !view ? { since: paused.at } : null,
    viewAs: view ? { staffEmail: view.staffEmail, expiresAt: view.expiresAt, paused: Boolean(paused) } : null,
    legal: view ? { version: LEGAL_VERSION, accepted: true, acceptance: null } : {
      version: LEGAL_VERSION,
      accepted: (await authService.hasAcceptedCurrentLegal(session.user.id)),
      acceptance: (await authService.legalAcceptance(session.user.id)),
    },
  });
}));

/** Public legal bundle. Signed-in callers also receive their acceptance status. */
authRouter.get("/legal", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  res.json({
    ...publicLegalBundle(),
    acceptance: session ? (await authService.legalAcceptance(session.user.id)) : null,
    accepted: session ? (await authService.hasAcceptedCurrentLegal(session.user.id)) : false,
  });
}));

authRouter.post("/legal/accept", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const session = token ? (await authService.verifyPrincipal(token)) : null;
  if (!session) return res.status(401).json({ error: "Not signed in" });
  try {
    const acceptance = (await authService.acceptLegal(
      session.user.id,
      String(req.body?.version ?? ""),
      String(req.body?.source ?? "web"),
    ));
    res.json({ accepted: true, acceptance, version: LEGAL_VERSION });
  } catch (err: any) {
    res.status(err?.status ?? 400).json({ error: err.message, code: err?.code });
  }
}));

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

/** The browser's chat socket: a one-minute, single-use ticket instead of the session token in the URL. */
authRouter.post("/ws-ticket", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const ticket = token ? (await authService.createWsTicket(token)) : null;
  if (!ticket) return res.status(401).json({ error: "Not signed in" });
  res.json({ ticket });
}));

// ---------- sessions: see them, end one, end all, rotate ----------

authRouter.get("/sessions", asyncHandler(async (req, res) => {
  const s = (await sessionOf(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  res.json({ sessions: (await authService.listSessions(s.user.id, s.token)) });
}));

authRouter.delete("/sessions/:id", asyncHandler(async (req, res) => {
  const s = (await sessionOf(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  const ok = (await authService.revokeSession(s.user.id, String(req.params.id)));
  res.status(ok ? 200 : 404).json({ ok });
}));

/** Sign out everywhere else (or everywhere, with {includeThis: true}). */
authRouter.post("/logout-all", asyncHandler(async (req, res) => {
  const s = (await sessionOf(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  const ended = (await authService.logoutAll(s.user.id, req.body?.includeThis === true ? undefined : s.token));
  if (req.body?.includeThis === true) (await authService.logout(s.token));
  void (await notify(s.user.id, "You were signed out of ORVYN everywhere", "All other devices signed in to your ORVYN account were signed out."));
  res.json({ ended });
}));

/** A fresh session token for this device; the old one stops working (reuse ends the whole family). */
authRouter.post("/refresh", asyncHandler(async (req, res) => {
  const token = bearerToken(req);
  const next = token ? (await authService.rotateSession(token)) : null;
  if (!next) return res.status(401).json({ error: "Session expired — sign in again." });
  res.json({ token: next });
}));

// ---------- password reset ----------

const resetSent = new Map<string, number>();

/** Sends a password-reset link (staff "Send password reset"). At most one a minute per email. */
export async function sendPasswordReset(req: Request, emailInput: string): Promise<{ sent: boolean; error?: string }> {
  const email = emailInput.trim().toLowerCase();
  if (!mailConfigured()) return { sent: false, error: "Email is not configured on this server." };
  if (Date.now() - (resetSent.get(email) ?? 0) < 60_000) return { sent: false, error: "A reset email was sent less than a minute ago." };
  const reset = (await authService.createPasswordReset(email));
  if (!reset) return { sent: false, error: "No account uses that email." };
  resetSent.set(email, Date.now());
  const link = `${publicOrigin(req)}/api/v1/auth/reset?token=${encodeURIComponent(reset.token)}`;
  try {
    await sendMail(passwordResetMail({ to: reset.user.email, name: reset.user.name, link }));
    return { sent: true };
  } catch (err: any) {
    resetSent.delete(email);
    console.warn(JSON.stringify({ event: "auth.reset.send_failed", error: String(err?.code ?? err?.message ?? err).slice(0, 80) }));
    return { sent: false, error: "The reset email could not be sent. Try again in a moment." };
  }
}

/** Always answers the same, whether or not the account exists. */
authRouter.post("/password/forgot", asyncHandler(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const answer = { ok: true, message: "If an account uses that email, a reset link is on its way." };
  if (!email || Date.now() - (resetSent.get(email) ?? 0) < 60_000) return res.json(answer);
  resetSent.set(email, Date.now());
  const reset = (await authService.createPasswordReset(email));
  if (reset && mailConfigured()) {
    const link = `${publicOrigin(req)}/api/v1/auth/reset?token=${encodeURIComponent(reset.token)}`;
    try { await sendMail(passwordResetMail({ to: reset.user.email, name: reset.user.name, link })); } catch (err: any) {
      console.warn(JSON.stringify({ event: "auth.reset.send_failed", error: String(err?.code ?? err?.message ?? err).slice(0, 80) }));
    }
  }
  res.json(answer);
}));

authRouter.post("/password/reset", asyncHandler(async (req, res) => {
  try {
    const user = (await authService.resetPassword(String(req.body?.token ?? ""), String(req.body?.password ?? "")));
    void (await notify(user.id, "Your ORVYN password was changed", "Your password was just changed and every device was signed out."));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
}));

/** The page the reset email links to (works without the app). */
authRouter.get("/reset", (req, res) => {
  const token = String(req.query.token ?? "");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.type("html").send(page("Choose a new password", `
<form id="f" style="display:grid;gap:12px;margin-top:18px;text-align:left">
  <input type="hidden" id="t" value="${escapeAttr(token)}">
  <label>New password<input id="p" type="password" minlength="8" autocomplete="new-password" required style="${INPUT}"></label>
  <label>Repeat it<input id="p2" type="password" minlength="8" autocomplete="new-password" required style="${INPUT}"></label>
  <button style="padding:12px;border:0;border-radius:10px;color:#fff;font-weight:600;background:linear-gradient(90deg,#7C4DFF,#31C8FF);cursor:pointer">Set password</button>
  <p id="m" style="color:#9DAAC7;min-height:1.4em"></p>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (e) => {
  e.preventDefault();
  const m = document.getElementById('m'); const p = document.getElementById('p').value;
  if (p !== document.getElementById('p2').value) { m.textContent = 'The passwords do not match.'; return; }
  const r = await fetch(location.pathname.replace(/\/reset$/, '/password/reset'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: document.getElementById('t').value, password: p }) });
  const d = await r.json().catch(() => ({}));
  m.textContent = r.ok ? 'Password changed. Sign in to ORVYN with your new password.' : (d.error || 'That did not work. Request a new link.');
  if (r.ok) document.querySelectorAll('input,button').forEach((x) => x.disabled = true);
});
</script>`));
});

// ---------- sign in with Google / GitHub ----------

function b64url(buf: Buffer): string { return buf.toString("base64url"); }

/**
 * Starts provider sign-in. Desktop: ?client=desktop&hid=<id>&challenge=<S256(verifier)>
 * (the app later claims the session with its verifier). No token ever rides a URL.
 */
authRouter.get("/oauth/:provider/start", asyncHandler(async (req, res) => {
  const provider = String(req.params.provider);
  const p = oauthProvider(provider);
  if (!p || !oauthConfigured(provider)) return res.status(404).type("html").send(page("Not available", `<p>Sign-in with ${escapeHtml(provider)} isn't switched on.</p>`));
  const client = req.query.client === "desktop" ? "desktop" : "web";
  let handoffId: string | undefined;
  try {
    // Desktop and the Cloud portal both hand the session over by claim (id + secret verifier).
    if (client === "desktop" || req.query.hid) {
      handoffId = String(req.query.hid ?? "");
      (await authService.startHandoff(handoffId, String(req.query.challenge ?? "")));
    }
  } catch (err: any) {
    return res.status(400).type("html").send(page("Sign-in didn't start", `<p>${escapeHtml(err.message)}. Go back to ORVYN and try again.</p>`));
  }
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  (await authService.saveOAuthState({ state, provider, verifier, client, handoffId }));
  res.redirect(302, authorizeUrl(p, { redirectUri: `${publicOrigin(req)}/api/v1/auth/oauth/${provider}/callback`, state, challenge }));
}));

authRouter.get("/oauth/:provider/callback", asyncHandler(async (req, res) => {
  const provider = String(req.params.provider);
  const p = oauthProvider(provider);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  const fail = (msg: string) => res.status(400).type("html").send(page("Sign-in didn't finish", `<p>${escapeHtml(msg)}</p><p>Go back to ORVYN and try again.</p>`));
  if (!p || !oauthConfigured(provider)) return fail("This sign-in method isn't switched on.");
  if (req.query.error) return fail("Sign-in was cancelled.");
  const saved = (await authService.takeOAuthState(String(req.query.state ?? ""), provider));
  if (!saved) return fail("This sign-in link expired or was already used.");
  try {
    // "Connect GitHub" (repository access) shares this callback: the link id names the ORVYN account.
    if (saved.client === "github-connect" && provider === "github" && saved.handoffId) {
      const out = await exchangeCodeWithToken(p, { code: String(req.query.code ?? ""), redirectUri: `${publicOrigin(req)}/api/v1/auth/oauth/${provider}/callback`, verifier: saved.verifier });
      const userId = (await authService.takeGithubLink(saved.handoffId));
      if (!userId) return fail("This connect link expired.");
      (await saveGithubConnection(userId, { token: out.accessToken, login: out.profile.name ?? "", scope: out.scope }));
      return res.type("html").send(page("GitHub connected", "<p>Go back to ORVYN — it continues on its own. You can close this tab.</p>"));
    }
    const profile = await exchangeCode(p, { code: String(req.query.code ?? ""), redirectUri: `${publicOrigin(req)}/api/v1/auth/oauth/${provider}/callback`, verifier: saved.verifier });
    const user = (await authService.userForOAuth({ provider, subject: profile.subject, email: profile.email, emailVerified: profile.emailVerified, name: profile.name }));
    (await onboardingStore().track(user.id, "signup_completed", { method: provider }));
    if (saved.client === "desktop" && saved.handoffId) {
      if (!(await authService.completeHandoff(saved.handoffId, user.id))) return fail("This sign-in request expired.");
      return res.type("html").send(page("You're signed in", "<p>Go back to ORVYN — it continues on its own. You can close this tab.</p>"));
    }
    // The Cloud portal: back to the portal, which claims its session with the
    // verifier it kept (the URL carries only the public handoff id).
    if (saved.handoffId) {
      if (!(await authService.completeHandoff(saved.handoffId, user.id))) return fail("This sign-in request expired.");
      return res.redirect(302, `${publicOrigin(req)}/signin?complete=${encodeURIComponent(saved.handoffId)}`);
    }
    return res.type("html").send(page("You're signed in", "<p>You can close this tab and return to ORVYN.</p>"));
  } catch (err: any) {
    console.warn(JSON.stringify({ event: "auth.oauth.failed", provider, reason: String(err?.message ?? err).slice(0, 120) }));
    return fail(/verified email/.test(String(err?.message)) ? err.message : "The provider didn't confirm your sign-in.");
  }
}));

/** "Connect GitHub" from a signed-in app: a one-time link the browser opens (no session in the URL). */
authRouter.post("/github/connect-link", asyncHandler(async (req, res) => {
  const s = (await sessionOf(req));
  if (!s) return res.status(401).json({ error: "Not signed in" });
  if (!oauthConfigured("github")) return res.status(404).json({ error: "GitHub connection isn't switched on." });
  const link = (await authService.createGithubLink(s.user.id));
  res.json({ url: `${publicOrigin(req)}/api/v1/auth/github/connect?link=${encodeURIComponent(link)}` });
}));

authRouter.get("/github/connect", asyncHandler(async (req, res) => {
  const p = oauthProvider("github");
  if (!p || !oauthConfigured("github")) return res.status(404).type("html").send(page("Not available", "<p>GitHub connection isn't switched on.</p>"));
  const link = String(req.query.link ?? "");
  if (!(await authService.githubLinkValid(link))) return res.status(400).type("html").send(page("This link expired", "<p>Go back to ORVYN and choose Connect GitHub again.</p>"));
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32));
  (await authService.saveOAuthState({ state, provider: "github", verifier, client: "github-connect", handoffId: link }));
  res.redirect(302, authorizeUrl(p, { redirectUri: `${publicOrigin(req)}/api/v1/auth/oauth/github/callback`, state, challenge: b64url(createHash("sha256").update(verifier).digest()), scope: "repo read:user user:email" }));
}));

/** The desktop claims its session with the secret verifier: "pending" until the browser finishes; the token exactly once. */
authRouter.post("/handoff/claim", asyncHandler(async (req, res) => {
  const out = (await authService.claimHandoff(String(req.body?.hid ?? ""), String(req.body?.verifier ?? ""), deviceOf(req)));
  if (out.status === "pending") return res.status(202).json({ status: "pending" });
  if (out.status === "invalid") return res.status(400).json({ status: "invalid", error: "This sign-in request expired. Try again." });
  const session = (await authService.verifyPrincipal(out.token))!;
  res.json({ status: "ok", token: out.token, user: session.user, principal: session.principal, organizations: (await authService.listOrganizations(session.user.id)) });
}));

const INPUT = "display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:10px 12px;border-radius:8px;border:1px solid #2a3350;background:#0b1024;color:#F8FAFF;font:inherit";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
function escapeAttr(s: string): string { return escapeHtml(s); }

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · ORVYN</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 50% 30%,#1a1045 0%,#050816 60%);font-family:Inter,Segoe UI,Arial,sans-serif;color:#F8FAFF">
<main style="text-align:center;padding:32px;max-width:420px;width:100%"><div style="font-weight:700;letter-spacing:.16em;margin-bottom:22px">ORVYN</div>
<h1 style="font-size:24px;margin:0 0 10px">${escapeHtml(title)}</h1><div style="color:#9DAAC7;line-height:1.6">${body}</div></main></body></html>`;
}
