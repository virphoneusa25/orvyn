// apps/backend/src/routes/account.ts
//
// The customer portal's account area: profile, password, team (members,
// invitations, roles), personal API keys, connected apps and the in-app
// notification feed. Mounted on the tenant chain (/api/v1/account), so every
// call already has a verified session principal.
//
// Account management is for people: a personal API key can use ORVYN but can
// never manage the account (it could otherwise mint more keys or add people).

import { Router, type Request, type Response } from "express";
import { authService } from "../auth/AuthService";
import { creditLedger } from "../billing/creditLedgerInstance";
import { planById } from "../billing/plans";
import { githubConnection } from "../integrations/githubConnection";
import { deploymentConnections, removeDeploymentConnection, saveDeploymentConnection } from "../integrations/deploymentConnections";
import { mailConfigured, securityNoticeMail, sendMail, teamInviteMail } from "../onboarding/mailer";
import { requirePrincipal } from "../middleware/tenant";
import { publicOrigin } from "./auth";
import type { OrgRole, Principal } from "../identity/principal";
import { sandboxRegistry } from "../execution/sandbox/SandboxRegistry";
import { decideRequest, TEMPLATE_LABELS } from "../execution/sandbox/policyRequests";

export const accountRouter = Router();

function bearer(req: Request): string | undefined {
  const h = req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : undefined;
}

/** A signed-in person (not an API key, not a read-only support view). */
function person(req: Request, res: Response, write = true): Principal | null {
  let principal: Principal;
  try { principal = requirePrincipal(req); } catch { res.status(401).json({ error: "Sign in to manage your account." }); return null; }
  if ((req as Request & { apiKeyId?: string }).apiKeyId) { res.status(403).json({ error: "API keys can't manage the account.", code: "API_KEY_FORBIDDEN" }); return null; }
  if (write && (req as Request & { viewAs?: unknown }).viewAs) { res.status(403).json({ error: "Support view is read-only.", code: "READ_ONLY_VIEW" }); return null; }
  return principal;
}

function fail(res: Response, err: any): void {
  res.status(err?.status ?? 400).json({ error: String(err?.message ?? err), code: err?.code });
}

function seatsFor(tenantId: string): number {
  return planById(creditLedger.planOf(tenantId) ?? "free").features.teamSeats;
}

// ── Profile & password ───────────────────────────────────────────────────

accountRouter.patch("/profile", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const name = String(req.body?.name ?? "").trim();
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Enter your name (2–80 characters)." });
  authService.setName(p.userId, name);
  res.json({ ok: true, name });
});

accountRouter.post("/password", async (req, res) => {
  const p = person(req, res);
  if (!p) return;
  try {
    const ended = authService.changePassword(p.userId, String(req.body?.current ?? ""), String(req.body?.next ?? ""), bearer(req));
    if (mailConfigured()) {
      void sendMail(securityNoticeMail({ to: p.email, name: p.name, subject: "Your ORVYN password was changed", message: "Your ORVYN password was just changed. Every other device was signed out." })).catch(() => undefined);
    }
    res.json({ ok: true, signedOut: ended });
  } catch (err) { fail(res, err); }
});

// ── Team ──────────────────────────────────────────────────────────────────

accountRouter.get("/team", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const org = authService.getOrganization(p.organizationId);
  const members = authService.listMembers(p.organizationId);
  const invites = authService.listInvites(p.organizationId);
  const role = authService.memberRole(p.organizationId, p.userId) ?? p.role;
  const seats = seatsFor(p.tenantId);
  res.json({
    organization: org ? { id: org.id, name: org.name, kind: org.kind } : null,
    role,
    canManage: role === "owner" || role === "admin",
    members: members.map((m) => ({ ...m, you: m.userId === p.userId })),
    invites,
    seats: { included: seats, used: members.filter((m) => m.role !== "owner").length + invites.length },
    plan: planById(creditLedger.planOf(p.tenantId) ?? "free").label,
  });
});

accountRouter.patch("/team", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  try { res.json({ organization: authService.renameOrganization(p, String(req.body?.name ?? "")) }); } catch (err) { fail(res, err); }
});

accountRouter.post("/team/invites", async (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const role: OrgRole = req.body?.role === "admin" ? "admin" : "member";
  try {
    const { token, invite } = authService.createInvite(p, String(req.body?.email ?? ""), role, seatsFor(p.tenantId));
    const org = authService.getOrganization(p.organizationId);
    const link = `${publicOrigin(req)}/invite?token=${encodeURIComponent(token)}`;
    let emailed = false;
    if (mailConfigured()) {
      try {
        await sendMail(teamInviteMail({ to: invite.email, workspace: org?.name ?? "ORVYN", invitedBy: p.name || p.email, role, link }));
        emailed = true;
      } catch { /* the link below still works */ }
    }
    // The link is shown once to the inviter too, so an invitation never depends on email delivery.
    res.status(201).json({ invite, link, emailed });
  } catch (err) { fail(res, err); }
});

accountRouter.delete("/team/invites/:id", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  try { res.json({ ok: authService.revokeInvite(p, String(req.params.id)) }); } catch (err) { fail(res, err); }
});

/** What an invitation is for, before joining (only the invited email may accept). */
accountRouter.get("/invites/:token", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const info = authService.inviteInfo(String(req.params.token));
  if (!info) return res.status(410).json({ error: "This invitation has expired or was already used. Ask for a new one." });
  res.json({ organizationName: info.organizationName, role: info.role, invitedBy: info.invitedBy, email: info.email, matches: info.email === p.email });
});

accountRouter.post("/invites/accept", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const user = authService.getUser(p.userId);
  if (!user) return res.status(401).json({ error: "Sign in again." });
  try {
    const org = authService.acceptInvite(String(req.body?.token ?? ""), user);
    res.json({ organization: { id: org.id, name: org.name, kind: org.kind } });
  } catch (err) { fail(res, err); }
});

accountRouter.post("/invites/:id/accept", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const user = authService.getUser(p.userId);
  if (!user) return res.status(401).json({ error: "Sign in again." });
  try {
    const org = authService.acceptInviteById(String(req.params.id), user);
    res.json({ organization: { id: org.id, name: org.name, kind: org.kind } });
  } catch (err) { fail(res, err); }
});

accountRouter.post("/invites/:id/decline", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const user = authService.getUser(p.userId);
  res.json({ ok: user ? authService.declineInvite(String(req.params.id), user) : false });
});

accountRouter.patch("/team/members/:userId", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  const role = req.body?.role;
  if (role !== "admin" && role !== "member") return res.status(400).json({ error: "Role must be admin or member." });
  try { authService.setMemberRole(p, String(req.params.userId), role); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

accountRouter.delete("/team/members/:userId", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  try { authService.removeMember(p, String(req.params.userId)); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

accountRouter.post("/team/leave", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  try { authService.removeMember(p, p.userId); res.json({ ok: true }); } catch (err) { fail(res, err); }
});

// ── Personal API keys ─────────────────────────────────────────────────────

accountRouter.get("/api-keys", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const included = planById(creditLedger.planOf(p.tenantId) ?? "free").features.apiAccess;
  res.json({ included, keys: authService.listApiKeys(p.userId, p.organizationId) });
});

accountRouter.post("/api-keys", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  if (!planById(creditLedger.planOf(p.tenantId) ?? "free").features.apiAccess) {
    return res.status(402).json({ error: "API access is included on the Business and Team plans.", code: "API_ACCESS_PLAN" });
  }
  try {
    const { key, record } = authService.createApiKey(p, String(req.body?.name ?? ""));
    // The full key is returned exactly once; only its hash is stored.
    res.status(201).json({ key, record });
  } catch (err) { fail(res, err); }
});

accountRouter.delete("/api-keys/:id", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  res.json({ ok: authService.revokeApiKey(p.userId, String(req.params.id)) });
});

// ── Connected apps ────────────────────────────────────────────────────────

accountRouter.get("/connections", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const sessions = authService.listSessions(p.userId, bearer(req));
  const desktops = sessions.filter((s) => /desktop|electron|orvyn/i.test(s.device) && !/browser|chrome|firefox|safari|edge/i.test(s.device));
  res.json({
    github: githubConnection(p.userId),
    deployment: deploymentConnections(p.tenantId),
    desktop: { connected: desktops.length > 0, devices: desktops.map((d) => ({ id: d.id, device: d.device, lastUsedAt: d.lastUsedAt })) },
  });
});

accountRouter.put("/connections/:id", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  if (p.role !== "owner" && p.role !== "admin") return res.status(403).json({ error: "Only a workspace owner or admin can manage deployment credentials." });
  try { saveDeploymentConnection(p.tenantId, String(req.params.id), String(req.body?.token ?? "")); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});

accountRouter.delete("/connections/:id", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  if (p.role !== "owner" && p.role !== "admin") return res.status(403).json({ error: "Only a workspace owner or admin can manage deployment credentials." });
  try { removeDeploymentConnection(p.tenantId, String(req.params.id)); res.json({ ok: true }); }
  catch (err) { fail(res, err); }
});

// ── Network access requests from cloud missions ─────────────────────────
// A mission's workspace starts with no network. When ORION needs some, it
// files a request; an owner or admin of the organization decides here.

function canManage(p: Principal): boolean {
  const role = authService.memberRole(p.organizationId, p.userId) ?? p.role;
  return role === "owner" || role === "admin";
}

function requestView(r: ReturnType<ReturnType<typeof sandboxRegistry>["policyRequest"]>) {
  if (!r) return null;
  return {
    id: r.id, runId: r.runId, access: TEMPLATE_LABELS[r.template as keyof typeof TEMPLATE_LABELS] ?? r.template,
    hosts: r.params.host ?? [], reason: r.reason, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt,
  };
}

accountRouter.get("/network-requests", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const rows = sandboxRegistry().policyRequests({ organizationId: p.organizationId, limit: 50 });
  res.json({ canDecide: canManage(p), requests: rows.map(requestView) });
});

accountRouter.post("/network-requests/:id", (req, res) => {
  const p = person(req, res);
  if (!p) return;
  if (!canManage(p)) return res.status(403).json({ error: "Only an owner or admin can decide network access." });
  if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve must be true or false." });
  try {
    const out = decideRequest(sandboxRegistry(), req.params.id, req.body.approve, `user:${p.userId}`, { organizationId: p.organizationId });
    if (!out) return res.status(404).json({ error: "Request not found." });
    res.json({ request: requestView(out) });
  } catch (err) { fail(res, err); }
});

// ── Notifications (derived from the account's real state) ───────────────

accountRouter.get("/notifications", (req, res) => {
  const p = person(req, res, false);
  if (!p) return;
  const w = creditLedger.snapshot(p.tenantId);
  const out: { id: string; kind: "warning" | "info" | "danger"; title: string; body: string; href?: string; at: number; inviteId?: string }[] = [];
  const now = Date.now();
  if (w.subscription.status === "past_due" || w.subscription.status === "unpaid") {
    out.push({ id: "payment", kind: "danger", title: "Your payment didn't go through", body: "Update your payment method to keep your plan.", href: "/billing", at: now });
  }
  const monthly = w.windows.cycle.limit || 1;
  if (w.availableBalance <= Math.max(50, monthly * 0.1)) {
    out.push({ id: "credits-low", kind: "warning", title: "Credits are running low", body: `${Math.max(0, Math.round(w.availableBalance)).toLocaleString("en-US")} credits left. Add credits or upgrade to keep going.`, href: "/billing#credits", at: now });
  }
  for (const [id, label, win] of [["win-5h", "5-hour", w.windows.fiveHour], ["win-7d", "7-day", w.windows.sevenDay]] as const) {
    if (win.limit > 0 && win.used / win.limit >= 0.8) {
      out.push({ id, kind: "warning", title: `You've used ${Math.min(100, Math.round((win.used / win.limit) * 100))}% of your ${label} allowance`, body: `It refills ${new Date(win.resetAt).toUTCString().slice(0, 22)} UTC.`, href: "/usage", at: now });
    }
  }
  if (canManage(p)) {
    try {
      for (const r of sandboxRegistry().policyRequests({ organizationId: p.organizationId, status: "pending", limit: 10 })) {
        const label = TEMPLATE_LABELS[r.template as keyof typeof TEMPLATE_LABELS] ?? r.template;
        out.push({ id: `netreq-${r.id}`, kind: "warning", title: `A task is asking for network access: ${label}`, body: `${r.reason || "No reason given."}${r.params.host?.length ? ` (${r.params.host.join(", ")})` : ""}`, at: r.createdAt, networkRequestId: r.id } as any);
      }
    } catch { /* registry unavailable */ }
  }
  const invites = authService.invitesForEmail(p.email);
  for (const i of invites) {
    out.push({ id: `invite-${i.id}`, kind: "info", title: `Invitation to ${i.organizationName}`, body: `${i.invitedBy ?? "Someone"} invited you to join as ${i.role === "admin" ? "an admin" : "a member"}.`, at: i.createdAt, inviteId: i.id });
  }
  res.json({ notifications: out });
});
