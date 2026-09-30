// apps/backend/src/routes/admin.ts
//
// The ORVYN Admin Portal API (/api/v1/admin). Mounted BEFORE the customer
// middleware chain and guarded here: a valid session whose user is platform
// staff (admin/staffStore.ts), with the permission the route needs. A
// customer's org "owner" role grants nothing here.
//
// Every write is audited (append-only admin_audit). Money moves only through
// the ledger (credits) or Stripe (plans) — never by editing a balance.

import { Router, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { authService } from "../auth/AuthService";
import { can, staffStore, STAFF_ROLES, SUSPEND_CATEGORIES, type StaffPermission, type StaffRole } from "../admin/staffStore";
import { adminService, AUDIT_TITLES, CUSTOMER_FILTERS, CREDIT_VALUE_USD, type CustomerFilter } from "../admin/AdminService";
import { creditLedger } from "../billing/creditLedgerInstance";
import { BillingLimitError } from "../billing/CreditLedger";
import { billingService, priceIdFor, purchasablePacks, stripeStore, StripeApiError } from "../billing/stripe";
import { CREDIT_PACKS, PLANS, type PlanId } from "../billing/plans";
import { sendPasswordReset, sendVerification } from "./auth";
import { mailConfigured, passwordResetMail, paymentFailedMail, securityNoticeMail, verificationMail } from "../onboarding/mailer";
import { verificationRequired } from "../onboarding/provisioning";
import { accountGateEnabled } from "../middleware/accountReady";
import { workerRuntimeReports, workerStats } from "./worker";
import { sandboxRegistry } from "../execution/sandbox/SandboxRegistry";
import { OPENSHELL_FLAG } from "../execution/sandbox/selection";
import { decideRequest } from "../execution/sandbox/policyRequests";
import { redisHealth } from "../identity/redisNamespace";
import { providerHealthSnapshot } from "../models/modelAvailability";
import { tenantManager, creditsEnforced } from "../tenancy/TenantManager";
import { customerCatalogEnabled } from "../models/customerCatalog";
import { defaultDataDir } from "../persistence/LocalStore";
import { artifactStorageRoot } from "../documents/workspace";
import { adminHostMismatch } from "../http/hosts";

interface Staff { id: string; email: string; name: string | null; role: StaffRole }
type AdminRequest = Request & { staff?: Staff };

export const adminRouter = Router();

function bearer(req: Request): string | null {
  const h = req.header("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Server-side RBAC: staff only (403 for everyone else, including customer org owners). */
adminRouter.use((req: AdminRequest, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  // The Admin Portal lives on its own host; elsewhere the admin API doesn't exist.
  if (adminHostMismatch(req)) return res.status(404).json({ error: "Not found" });
  const token = bearer(req);
  const session = token ? authService.verifyPrincipal(token) : null;
  if (!session) return res.status(401).json({ error: "Sign in to continue.", code: "UNAUTHENTICATED" });
  let role = staffStore().roleOf(session.user.id);
  if (!role && process.env.ORVYN_SUPER_ADMIN_EMAILS) { staffStore().seedFromEnv(); role = staffStore().roleOf(session.user.id); }
  if (!role) {
    console.warn(JSON.stringify({ event: "admin.denied", path: req.path.slice(0, 80) }));
    return res.status(403).json({ error: "This area is for ORVYN staff.", code: "ADMIN_ONLY" });
  }
  req.staff = { id: session.user.id, email: session.user.email, name: session.user.name, role };
  next();
});

const need = (p: StaffPermission) => (req: AdminRequest, res: Response, next: NextFunction) => {
  if (!can(req.staff?.role, p)) return res.status(403).json({ error: "Your staff role can't do that.", code: "FORBIDDEN" });
  next();
};

function audit(req: AdminRequest, action: string, tenantId: string | null, detail: Record<string, unknown> = {}) {
  return staffStore().audit({ actorId: req.staff!.id, actorEmail: req.staff!.email, action, tenantId, detail, ip: req.ip ?? null });
}

/** The customer (tenant) in the path, or a 404. */
function customerOr404(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? "");
  if (!adminService().orgByTenant(id)) { res.status(404).json({ error: "No such customer." }); return null; }
  return id;
}

function fail(res: Response, err: unknown) {
  if (err instanceof StripeApiError) {
    const status = err.status === 503 ? 503 : err.status >= 400 && err.status < 500 ? err.status : 502;
    return res.status(status).json({ error: status === 502 ? "Stripe is unavailable right now. Try again in a minute." : err.message, code: status === 503 ? "STRIPE_UNAVAILABLE" : "STRIPE_ERROR" });
  }
  if (err instanceof BillingLimitError) return res.status(400).json({ error: err.message, code: err.code });
  const e = err as { status?: number; message?: string };
  if (e?.status && e.status < 500) return res.status(e.status).json({ error: e.message });
  console.error(JSON.stringify({ event: "admin.error", reason: String(e?.message ?? err).slice(0, 200) }));
  return res.status(500).json({ error: "Something went wrong. Try again." });
}

const wrap = (fn: (req: AdminRequest, res: Response) => unknown) => async (req: AdminRequest, res: Response) => {
  try { await fn(req, res); } catch (err) { fail(res, err); }
};

const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) ? Number(v) : d);

// ---------- who am I ----------

adminRouter.get("/me", (req: AdminRequest, res) => {
  const perms: StaffPermission[] = ["read", "billing.write", "support.write", "account.suspend", "staff.manage", "costs.read"];
  res.json({ staff: req.staff, permissions: perms.filter((p) => can(req.staff!.role, p)) });
});

// ---------- dashboard, search, notifications ----------

adminRouter.get("/dashboard", need("read"), wrap((req, res) => {
  const d = adminService().dashboard();
  if (!can(req.staff!.role, "costs.read")) (d as any).providerCosts = null;
  res.json(d);
}));

adminRouter.get("/search", need("read"), wrap(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const out: any = adminService().search(q);
  out.invoices = [];
  if (/^in_[A-Za-z0-9_]+$/.test(q) && billingService().enabled) {
    try {
      const inv = await billingService().adminInvoices({ limit: 100 });
      out.invoices = inv.invoices.filter((i) => i.id === q || i.number === q).slice(0, 5);
    } catch { /* Stripe unavailable: the rest still answers */ }
  }
  res.json(out);
}));

adminRouter.get("/notifications", need("read"), wrap(async (_req, res) => {
  const items: { id: string; level: "warning" | "error" | "info"; title: string; detail: string; at: number; href?: string }[] = [];
  const since = Date.now() - 86_400_000;
  for (const e of stripeStore().failedEvents(since)) items.push({ id: `stripe:${e.id}`, level: "error", title: "Stripe webhook failed", detail: `${e.type}${e.error ? ` — ${e.error.slice(0, 80)}` : ""}`, at: e.received_at, href: "/admin/health" });
  const counts = adminService().counts();
  if (counts.past_due) items.push({ id: "past_due", level: "warning", title: `${counts.past_due} past-due customer${counts.past_due === 1 ? "" : "s"}`, detail: "Payment failed; Stripe is retrying.", at: Date.now(), href: "/admin/customers?filter=past_due" });
  for (const s of staffStore().pausedTenants().slice(0, 5)) items.push({ id: `paused:${s.tenantId}`, level: "info", title: `${adminService().orgByTenant(s.tenantId)?.name ?? "A customer"} is paused`, detail: `${s.category} · ${s.reason.slice(0, 60)}`, at: s.at, href: `/admin/customers/${s.tenantId}` });
  const health = await healthChecks();
  for (const h of health.checks) if (h.status === "down" || h.status === "degraded") items.push({ id: `health:${h.id}`, level: h.status === "down" ? "error" : "warning", title: `${h.name}: ${h.status}`, detail: h.detail, at: Date.now(), href: "/admin/health" });
  items.sort((a, b) => b.at - a.at);
  res.json({ items, unread: items.filter((i) => i.level !== "info").length });
}));

// ---------- customers ----------

adminRouter.get("/customers", need("read"), wrap((req, res) => {
  const filter = (CUSTOMER_FILTERS as readonly string[]).includes(String(req.query.filter)) ? (String(req.query.filter) as CustomerFilter) : "all";
  res.json(adminService().customers({ q: String(req.query.q ?? ""), filter, page: num(req.query.page, 1), pageSize: num(req.query.pageSize, 25), sort: String(req.query.sort ?? "") }));
}));

/** Invite a customer: the account is created and the customer sets their own password from an emailed link. */
adminRouter.post("/customers", need("support.write"), wrap(async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const name = String(req.body?.name ?? "").trim().slice(0, 80) || undefined;
  const orgName = String(req.body?.organization ?? "").trim().slice(0, 120);
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: "Enter a valid email." });
  let created;
  try {
    // A random password nobody knows; the customer chooses theirs through the reset link.
    created = authService.register(email, `${randomBytes(24).toString("base64url")}Aa1!`, name, "staff-invite");
  } catch (err: any) {
    return res.status(409).json({ error: /exist|taken|already/i.test(String(err?.message)) ? "An account already uses that email." : "Couldn't create that account." });
  }
  authService.logout(created.token);
  const tenantId = created.organization?.tenantId ?? authService.listOrganizations(created.user.id)[0]?.tenantId;
  if (orgName && created.organization?.id) staffStore().db.prepare(`UPDATE organizations SET name = ? WHERE id = ?`).run(orgName, created.organization.id);
  const mail = await sendPasswordReset(req, email);
  audit(req, "customer.create", tenantId ?? null, { email, emailed: mail.sent });
  res.status(201).json({ customer: { id: tenantId }, emailed: mail.sent });
}));

adminRouter.get("/customers/:id", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ customer: adminService().customer(id) });
}));

adminRouter.get("/customers/:id/usage", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const days = Math.min(90, Math.max(7, num(req.query.days, 30)));
  const series = adminService().usageSeries(id, days);
  if (!can(req.staff!.role, "costs.read")) for (const d of series) (d as any).costUsd = null;
  res.json({ days, series });
}));

adminRouter.get("/customers/:id/invoices", need("read"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  if (!billingService().enabled) return res.json({ invoices: [], stripe: "not_configured" });
  res.json({ ...(await billingService().adminInvoices({ accountId: id, limit: num(req.query.limit, 25), startingAfter: req.query.startingAfter ? String(req.query.startingAfter) : undefined })), stripe: "ok" });
}));

adminRouter.get("/customers/:id/payment-method", need("read"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  if (!billingService().enabled) return res.json({ paymentMethod: null, stripe: "not_configured" });
  try { res.json({ paymentMethod: (await billingService().account(id)).paymentMethod, stripe: "ok" }); }
  catch { res.json({ paymentMethod: null, stripe: "unavailable" }); }
}));

adminRouter.get("/customers/:id/projects", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ projects: adminService().projects(id) });
}));

adminRouter.get("/customers/:id/workspaces", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ workspaces: adminService().workspaces(id) });
}));

adminRouter.get("/customers/:id/chats", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ chats: adminService().chats(id, Math.min(200, num(req.query.limit, 50))) });
}));

adminRouter.get("/customers/:id/activity", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ activity: adminService().activity(id, Math.min(200, num(req.query.limit, 40))) });
}));

adminRouter.get("/customers/:id/audit", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ audit: staffStore().auditLog({ tenantId: id, before: req.query.before ? num(req.query.before, 0) : undefined, limit: num(req.query.limit, 50) }), titles: AUDIT_TITLES });
}));

adminRouter.get("/customers/:id/ledger", need("read"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  res.json({ entries: adminService().ledger(id, Math.min(500, num(req.query.limit, 100))), verify: creditLedger.verify(id) });
}));

/** The live Stripe subscription (read from Stripe, not guessed). */
adminRouter.get("/customers/:id/subscription", need("read"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const wallet = creditLedger.snapshot(id);
  const base = {
    plan: { id: wallet.plan.id, label: wallet.plan.label }, walletStatus: wallet.subscription?.status ?? "none",
    cycleStart: wallet.subscription?.cycleStart ?? null, cycleEnd: wallet.subscription?.cycleEnd ?? null,
    customerId: stripeStore().customerOf(id),
    plans: Object.values(PLANS).filter((p) => p.public || p.id === "enterprise").map((p) => ({ id: p.id, label: p.label, priceMonthlyUsd: p.priceMonthlyUsd, priceAnnualUsd: p.priceAnnualUsd, monthlyCredits: p.monthlyCredits, monthly: Boolean(priceIdFor({ planId: p.id, period: "monthly" })), yearly: Boolean(priceIdFor({ planId: p.id, period: "yearly" })) })),
  };
  if (!billingService().enabled) return res.json({ ...base, stripe: "not_configured", subscription: null });
  try {
    res.json({ ...base, stripe: "ok", subscription: await billingService().adminSubscription(id) });
  } catch (err) {
    if (err instanceof StripeApiError && err.status !== 503) return res.json({ ...base, stripe: "unavailable", subscription: null });
    throw err;
  }
}));

// ---------- customer actions ----------

const ADJUST_CATEGORIES = ["promotional", "billing_correction", "refund_adjustment", "goodwill", "other"];

adminRouter.post("/customers/:id/credits/adjust", need("billing.write"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const credits = Number(req.body?.credits);
  const reason = String(req.body?.reason ?? "").trim();
  const category = ADJUST_CATEGORIES.includes(String(req.body?.category)) ? String(req.body.category) : "other";
  const requestId = String(req.body?.requestId ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  if (!Number.isInteger(credits) || credits === 0) return res.status(400).json({ error: "Enter a whole, non-zero number of credits." });
  if (Math.abs(credits) > 10_000_000) return res.status(400).json({ error: "That's more than a single adjustment allows (10,000,000)." });
  if (reason.length < 3) return res.status(400).json({ error: "Give a reason (it goes on the ledger)." });
  if (!requestId) return res.status(400).json({ error: "Missing request id." });
  const key = `adjust:${id}:${requestId}`;
  const actor = `staff:${req.staff!.email}`;
  const before = creditLedger.snapshot(id);
  const entries = [];
  if (credits > 0) {
    entries.push(creditLedger.adminAdjust(id, credits, { actor, reason, category, bucket: "purchased", key }));
  } else {
    // A debit takes top-up credits first, then this cycle's included credits — never below zero.
    const take = -credits;
    if (take > before.includedBalance + before.purchasedBalance - before.reservedBalance) return res.status(400).json({ error: `Only ${(before.availableBalance).toLocaleString("en-US")} credits are available to remove.` });
    const fromPurchased = Math.min(take, before.purchasedBalance);
    const fromIncluded = take - fromPurchased;
    if (fromPurchased) entries.push(creditLedger.adminAdjust(id, -fromPurchased, { actor, reason, category, bucket: "purchased", key: `${key}:p` }));
    if (fromIncluded) entries.push(creditLedger.adminAdjust(id, -fromIncluded, { actor, reason, category, bucket: "included", key: `${key}:i` }));
  }
  const after = creditLedger.snapshot(id);
  // A replayed request (same id) returns the same entries and writes no second audit row.
  if (before.availableBalance !== after.availableBalance) audit(req, "credits.adjust", id, { credits, reason, category, entries: entries.map((e) => e.id), before: before.availableBalance, after: after.availableBalance });
  res.json({ entries, wallet: { available: after.availableBalance, purchased: after.purchasedBalance, included: after.includedBalance } });
}));

adminRouter.post("/customers/:id/password-reset", need("support.write"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const owner = adminService().owner(id);
  if (!owner) return res.status(404).json({ error: "This customer has no contact to email." });
  const out = await sendPasswordReset(req, owner.email);
  if (!out.sent) return res.status(out.error?.includes("configured") ? 503 : 429).json({ error: out.error });
  audit(req, "support.password_reset", id, { to: owner.email });
  res.json({ sent: true, to: owner.email });
}));

adminRouter.post("/customers/:id/resend-verification", need("support.write"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const owner = adminService().owner(id);
  if (!owner) return res.status(404).json({ error: "This customer has no contact to email." });
  if (authService.isEmailVerified(owner.userId)) return res.status(409).json({ error: "Their email is already verified." });
  const out = await sendVerification(req, owner.userId, owner.name);
  if (!out.sent) return res.status(out.error?.includes("configured") ? 503 : 429).json({ error: out.error });
  audit(req, "support.resend_verification", id, { to: owner.email });
  res.json({ sent: true, to: owner.email });
}));

adminRouter.post("/customers/:id/suspend", need("account.suspend"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  if (req.body?.confirm !== true) return res.status(400).json({ error: "Confirm the pause." });
  const s = staffStore().suspend(id, { reason: String(req.body?.reason ?? ""), category: String(req.body?.category ?? "other") }, req.staff!.email);
  audit(req, "account.suspend", id, { reason: s.reason, category: s.category });
  res.json({ suspension: s });
}));

adminRouter.post("/customers/:id/reactivate", need("account.suspend"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  if (!staffStore().reactivate(id, req.staff!.email)) return res.status(409).json({ error: "This account isn't paused." });
  audit(req, "account.reactivate", id, { reason: String(req.body?.reason ?? "").slice(0, 500) });
  res.json({ ok: true });
}));

adminRouter.post("/customers/:id/support-note", need("support.write"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const note = staffStore().addNote(id, { id: req.staff!.id, email: req.staff!.email }, String(req.body?.body ?? ""));
  audit(req, "support.note", id, { noteId: note.id });
  res.status(201).json({ note });
}));

adminRouter.put("/customers/:id/profile", need("support.write"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  staffStore().saveProfile(id, { website: req.body?.website, industry: req.body?.industry, location: req.body?.location }, req.staff!.email);
  audit(req, "profile.update", id, { fields: Object.keys(req.body ?? {}).filter((k) => ["website", "industry", "location"].includes(k)) });
  res.json({ profile: staffStore().profile(id) });
}));

/** Plan management. Paid changes go through Stripe (the webhook applies them); complimentary plans are super-admin only. */
adminRouter.post("/customers/:id/plan", need("billing.write"), wrap(async (req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const action = String(req.body?.action ?? "");
  const planId = String(req.body?.planId ?? "") as PlanId;
  const period = req.body?.period === "yearly" ? "yearly" : "monthly";
  const reason = String(req.body?.reason ?? "").trim().slice(0, 500);
  const validPlan = planId in PLANS;
  const svc = billingService();
  switch (action) {
    case "change": {
      if (!validPlan || planId === "free" || planId === "enterprise") return res.status(400).json({ error: "Choose a paid self-serve plan." });
      const out = await svc.adminChangePlan(id, planId, period, req.staff!.email);
      audit(req, "plan.change", id, { planId, period, reason, subscriptionId: out.subscriptionId });
      return res.json({ ok: true, message: "Stripe is updating the subscription. The plan and credits change when Stripe confirms the invoice." });
    }
    case "schedule": {
      if (!validPlan || planId === "free" || planId === "enterprise") return res.status(400).json({ error: "Choose a paid self-serve plan." });
      const out = await svc.adminScheduleChange(id, planId, period);
      audit(req, "plan.schedule", id, { planId, period, reason, effectiveAt: out.effectiveAt });
      return res.json({ ok: true, effectiveAt: out.effectiveAt, message: "The change takes effect at the next renewal." });
    }
    case "cancel_at_period_end":
    case "resume": {
      const out = await svc.adminCancelAtPeriodEnd(id, action === "cancel_at_period_end");
      audit(req, action === "resume" ? "plan.resume" : "plan.cancel_at_period_end", id, { reason, until: out.currentPeriodEnd });
      return res.json({ ok: true, currentPeriodEnd: out.currentPeriodEnd });
    }
    case "checkout_link": {
      if (!validPlan || planId === "free" || planId === "enterprise") return res.status(400).json({ error: "Choose a paid self-serve plan." });
      const owner = adminService().owner(id);
      if (!owner) return res.status(404).json({ error: "This customer has no contact." });
      const origin = `${String(req.header("x-forwarded-proto") || req.protocol)}://${String(req.header("x-forwarded-host") || req.get("host"))}`;
      const out = await svc.checkout({ accountId: id, email: owner.email, name: owner.name, planId, period, origin, returnTo: "portal" });
      audit(req, "plan.checkout_link", id, { planId, period });
      return res.json({ ok: true, url: out.url });
    }
    case "complimentary": {
      if (req.staff!.role !== "super_admin") return res.status(403).json({ error: "Only a super admin can assign a complimentary plan." });
      if (!validPlan || planId === "free") return res.status(400).json({ error: "Choose a plan." });
      if (reason.length < 3) return res.status(400).json({ error: "Give a reason." });
      const w = creditLedger.snapshot(id);
      const sub = stripeStore().latestSubscription(id);
      if (sub && ["active", "trialing", "past_due"].includes(sub.status)) return res.status(409).json({ error: "This customer pays through Stripe. Change the plan there instead." });
      creditLedger.setPlan(id, planId, Date.now(), `staff:${req.staff!.email}`);
      audit(req, "plan.complimentary", id, { planId, reason, from: w.plan.id });
      return res.json({ ok: true });
    }
    case "end_complimentary": {
      if (req.staff!.role !== "super_admin") return res.status(403).json({ error: "Only a super admin can end a complimentary plan." });
      const row = adminService().customer(id);
      if (!row?.complimentary) return res.status(409).json({ error: "This customer isn't on a complimentary plan." });
      const wallet = creditLedger.snapshot(id);
      creditLedger.endSubscription(id, creditLedger.subscriptionIdOf(id) ?? "");
      audit(req, "plan.complimentary_end", id, { reason, from: wallet.plan.id });
      return res.json({ ok: true });
    }
    default:
      return res.status(400).json({ error: "Unknown plan action." });
  }
}));

/** Read-only "View as customer": a 30-minute token that can only read (the customer API refuses writes). */
adminRouter.post("/customers/:id/view-as", need("support.write"), wrap((req, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const owner = adminService().owner(id);
  if (!owner) return res.status(404).json({ error: "This customer has no member to view as." });
  const out = staffStore().createViewAs({ id: req.staff!.id, email: req.staff!.email }, { userId: owner.userId, organizationId: owner.organizationId, tenantId: id });
  audit(req, "support.view_as", id, { as: owner.email, expiresAt: out.expiresAt, reason: String(req.body?.reason ?? "").slice(0, 300) });
  res.json(out);
}));

// ---------- lists ----------

adminRouter.get("/organizations", need("read"), wrap((req, res) => {
  res.json(adminService().customers({ q: String(req.query.q ?? ""), filter: "all", page: num(req.query.page, 1), pageSize: num(req.query.pageSize, 25), sort: String(req.query.sort ?? "") }));
}));

adminRouter.get("/subscriptions", need("read"), wrap((req, res) => {
  res.json(adminService().subscriptions({ status: req.query.status ? String(req.query.status) : undefined, page: num(req.query.page, 1), pageSize: num(req.query.pageSize, 25) }));
}));

adminRouter.get("/usage", need("read"), wrap((req, res) => {
  const days = Math.min(90, Math.max(7, num(req.query.days, 30)));
  res.json({ days, series: adminService().usageSeries(null, days).map((d) => ({ day: d.day, credits: d.credits, tokens: d.tokens, missions: d.missions, chat: d.chat })), top: adminService().topConsumers(days, num(req.query.page, 1)), adjustments: adminService().adjustments(30) });
}));

adminRouter.get("/invoices", need("read"), wrap(async (req, res) => {
  if (!billingService().enabled) return res.json({ invoices: [], hasMore: false, stripe: "not_configured" });
  const out = await billingService().adminInvoices({ limit: num(req.query.limit, 25), startingAfter: req.query.startingAfter ? String(req.query.startingAfter) : undefined });
  res.json({ ...out, invoices: out.invoices.map((i) => ({ ...i, customer: i.accountId ? adminService().orgByTenant(i.accountId)?.name ?? null : null })), stripe: "ok" });
}));

adminRouter.get("/support", need("read"), wrap((_req, res) => {
  const name = (t: string) => adminService().orgByTenant(t)?.name ?? t;
  res.json({
    notes: staffStore().notes(undefined, 50).map((n) => ({ ...n, customer: name(n.tenantId) })),
    paused: staffStore().pausedTenants().map((s) => ({ ...s, customer: name(s.tenantId) })),
    actions: staffStore().auditLog({ action: "support.", limit: 50 }).map((a) => ({ ...a, customer: a.tenantId ? name(a.tenantId) : null, title: AUDIT_TITLES[a.action] ?? a.action })),
  });
}));

adminRouter.get("/plans", need("read"), wrap((_req, res) => {
  const dash = adminService().dashboard();
  res.json({
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, label: p.label, public: p.public, priceMonthlyUsd: p.priceMonthlyUsd, priceAnnualUsd: p.priceAnnualUsd, monthlyCredits: p.monthlyCredits,
      rolling5h: p.rolling5h, rolling7d: p.rolling7d, parallelAgents: p.concurrentRuns, features: p.features,
      stripe: { monthly: Boolean(priceIdFor({ planId: p.id, period: "monthly" })), yearly: Boolean(priceIdFor({ planId: p.id, period: "yearly" })) },
      customers: dash.revenueByPlan.find((r) => r.plan === p.id)?.customers ?? 0, mrr: dash.revenueByPlan.find((r) => r.plan === p.id)?.mrr ?? 0,
    })),
    note: "Plans are defined in code (billing/plans.ts) and priced by the Stripe price ids set in the environment.",
  });
}));

adminRouter.get("/topups", need("read"), wrap((req, res) => {
  const days = Math.min(365, Math.max(7, num(req.query.days, 30)));
  const sales = adminService().topups(days);
  res.json({ days, packs: purchasablePacks().map((p) => ({ ...p, sales: sales.get(p.id) ?? { purchases: 0, credits: 0, revenueUsd: 0 } })) });
}));

/** Runtime switches (set by deployment configuration, shown read-only). */
adminRouter.get("/flags", need("read"), wrap((_req, res) => {
  const env = process.env;
  const flag = (key: string, label: string, on: boolean, description: string) => ({ key, label, on, description, source: "deployment" });
  res.json({
    flags: [
      flag("ORVYN_CLOUD_MODE", "Cloud mode", env.ORVYN_CLOUD_MODE === "true", "Multi-tenant ORVYN Cloud (per-account data, credits, catalog)."),
      flag("ORVYN_REQUIRE_ONBOARDING", "Account gate", accountGateEnabled(), "New accounts must finish setup before using ORVYN."),
      flag("ORVYN_REQUIRE_EMAIL_VERIFICATION", "Email verification", verificationRequired(), "New accounts verify their email first."),
      flag("customerCatalog", "Customer model catalog", customerCatalogEnabled(), "Customers see ORVYN model names only; vendor names are removed."),
      flag("creditsEnforced", "Credits enforced", creditsEnforced(), "Requests are metered and stopped when credits or windows run out."),
      flag("GOOGLE_CLIENT_ID", "Google sign-in", Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()), "Continue with Google."),
      flag("GITHUB_CLIENT_ID", "GitHub sign-in", Boolean(env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim()), "Continue with GitHub and repository access."),
      flag("STRIPE_SECRET_KEY", "Online payments", billingService().enabled, "Checkout, customer portal, auto-recharge."),
      flag("ORVYN_DESKTOP_DOWNLOAD_WINDOWS", "Desktop download link", Boolean(env.ORVYN_DESKTOP_DOWNLOAD_WINDOWS?.trim()), "Download Desktop page in the Cloud portal."),
    ],
  });
}));

adminRouter.get("/integrations", need("read"), wrap(async (_req, res) => {
  const env = process.env;
  const prices = [...Object.keys(PLANS).filter((p) => p !== "free" && p !== "enterprise").flatMap((p) => [`STRIPE_PRICE_${p.toUpperCase()}_MONTHLY`, `STRIPE_PRICE_${p.toUpperCase()}_ANNUAL`]), ...CREDIT_PACKS.map((p) => `STRIPE_PRICE_${p.id.toUpperCase()}`)];
  const configured = prices.filter((k) => env[k]?.trim() || env[k.replace(/_ANNUAL$/, "_YEARLY")]?.trim());
  const redis = await redisHealth();
  res.json({
    integrations: [
      { id: "stripe", name: "Stripe", status: billingService().enabled ? "connected" : "not_configured", detail: billingService().enabled ? `${configured.length}/${prices.length} prices configured · webhook secret ${env.STRIPE_WEBHOOK_SECRET?.trim() ? "set" : "missing"} · ${String(env.STRIPE_SECRET_KEY ?? "").startsWith("sk_live") || String(env.STRIPE_SECRET_KEY ?? "").startsWith("rk_live") ? "live mode" : "test mode"}` : "Set STRIPE_SECRET_KEY", missing: prices.filter((k) => !configured.includes(k)) },
      { id: "email", name: "Email (SMTP)", status: mailConfigured() ? "connected" : "not_configured", detail: mailConfigured() ? (env.ORVYN_MAIL_CAPTURE ? "capturing to files (test)" : `via ${String(env.SMTP_HOST ?? "").replace(/^.*?([^.]+\.[^.]+)$/, "$1")}`) : "Set SMTP_HOST, SMTP_USER, SMTP_PASS" },
      { id: "google", name: "Google sign-in", status: env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim() ? "connected" : "not_configured", detail: "OAuth (PKCE)" },
      { id: "github", name: "GitHub", status: env.GITHUB_CLIENT_ID?.trim() && env.GITHUB_CLIENT_SECRET?.trim() ? "connected" : "not_configured", detail: "Sign-in and repository access" },
      { id: "redis", name: "Redis", status: env.ORVYN_REDIS_URL ? (redis.healthy ? "connected" : "error") : "not_configured", detail: redis.detail ?? "" },
      { id: "postgres", name: "PostgreSQL", status: env.ORVYN_PG_URL ? "connected" : "not_configured", detail: env.ORVYN_PG_URL ? "identity schema" : "SQLite is authoritative" },
      { id: "providers", name: "Model providers", status: providerHealthSnapshot().length || env.MODEL_API_KEY || env.NEBIUS_API_KEY || env.FIREWORKS_API_KEY ? "connected" : "not_configured", detail: `${["NEBIUS_API_KEY", "FIREWORKS_API_KEY", "CHEAPER_INFERENCE_API_KEY", "OPENROUTER_API_KEY", "MODEL_API_KEY"].filter((k) => env[k]?.trim()).map((k) => k.replace(/_API_KEY$/, "").toLowerCase()).join(", ") || "none"} configured` },
    ],
  });
}));

const TEMPLATE_SAMPLES = {
  verification: () => verificationMail({ to: "customer@example.com", name: "Alex", link: "https://example.com/verify?token=sample" }),
  password_reset: () => passwordResetMail({ to: "customer@example.com", name: "Alex", link: "https://example.com/reset?token=sample" }),
  security_notice: () => securityNoticeMail({ to: "customer@example.com", name: "Alex", subject: "You were signed out of ORVYN everywhere", message: "All other devices signed in to your ORVYN account were signed out." }),
  payment_failed: () => paymentFailedMail({ to: "customer@example.com", name: "Alex", amountUsd: 59, link: "https://example.com/invoice" }),
} as const;
const TEMPLATE_INFO: Record<keyof typeof TEMPLATE_SAMPLES, { name: string; trigger: string }> = {
  verification: { name: "Email verification", trigger: "Sign-up, resend, change email" },
  password_reset: { name: "Password reset", trigger: "Forgot password, staff 'Send password reset'" },
  security_notice: { name: "Security notice", trigger: "Password changed, signed out everywhere" },
  payment_failed: { name: "Payment failed", trigger: "Stripe invoice.payment_failed" },
};

adminRouter.get("/email-templates", need("read"), wrap((_req, res) => {
  res.json({ templates: (Object.keys(TEMPLATE_SAMPLES) as (keyof typeof TEMPLATE_SAMPLES)[]).map((id) => ({ id, ...TEMPLATE_INFO[id], subject: TEMPLATE_SAMPLES[id]().subject })), mail: mailConfigured() ? "configured" : "not_configured" });
}));

adminRouter.get("/email-templates/:id", need("read"), wrap((req, res) => {
  const id = String(req.params.id) as keyof typeof TEMPLATE_SAMPLES;
  if (!TEMPLATE_SAMPLES[id]) return res.status(404).json({ error: "No such template." });
  const m = TEMPLATE_SAMPLES[id]();
  res.json({ id, ...TEMPLATE_INFO[id], subject: m.subject, text: m.text, html: m.html });
}));

adminRouter.get("/provider-costs", need("costs.read"), wrap((req, res) => {
  const days = Math.min(365, Math.max(1, num(req.query.days, 30)));
  res.json({ ...adminService().providerCosts(days), creditValueUsd: CREDIT_VALUE_USD, note: `Credit value is priced at $${CREDIT_VALUE_USD * 1000} per 1,000 credits.` });
}));

// ---------- operations ----------

type Check = { id: string; name: string; status: "operational" | "degraded" | "down" | "not_configured"; detail: string; latencyMs?: number };

async function healthChecks(): Promise<{ status: "operational" | "degraded" | "down"; checks: Check[] }> {
  const checks: Check[] = [];
  checks.push({ id: "api", name: "API Server", status: "operational", detail: `up ${Math.round(process.uptime() / 60)} min · ${Math.round(process.memoryUsage().rss / 1048576)} MB` });
  try {
    const p = adminService().ping();
    checks.push({ id: "database", name: "Database", status: "operational", detail: "accounts, ledger and payments reachable", latencyMs: Math.max(p.auth, p.billing, p.payments) });
  } catch (err: any) {
    checks.push({ id: "database", name: "Database", status: "down", detail: "a database did not answer" });
  }
  if (process.env.ORVYN_REDIS_URL) {
    const s = performance.now();
    const r = await redisHealth();
    checks.push({ id: "redis", name: "Redis", status: r.healthy ? "operational" : "down", detail: r.healthy ? "PING ok" : "unreachable", latencyMs: Math.round(performance.now() - s) });
  } else checks.push({ id: "redis", name: "Redis", status: "not_configured", detail: "not used by this deployment" });
  const w = workerStats();
  checks.push({ id: "workers", name: "Workers", status: w.total === 0 ? "not_configured" : w.online > 0 ? (w.online < w.total ? "degraded" : "operational") : "down", detail: `${w.online}/${w.total} online` });
  if (billingService().enabled) {
    const day = Date.now() - 86_400_000;
    const stats = stripeStore().eventStats(day);
    const failed = stats.find((x) => x.status === "failed")?.n ?? 0;
    const total = stats.reduce((a, x) => a + Number(x.n), 0);
    const last = stripeStore().lastEventAt();
    checks.push({ id: "stripe", name: "Stripe Webhooks", status: failed ? "degraded" : "operational", detail: `${total} event${total === 1 ? "" : "s"} in 24 h${failed ? ` · ${failed} failed` : ""}${last ? ` · last ${new Date(last).toISOString().slice(0, 16).replace("T", " ")} UTC` : " · none received yet"}` });
  } else checks.push({ id: "stripe", name: "Stripe Webhooks", status: "not_configured", detail: "payments not set up" });
  checks.push({ id: "email", name: "Email Service", status: mailConfigured() ? "operational" : "not_configured", detail: mailConfigured() ? "SMTP configured" : "SMTP not configured" });
  try {
    const root = artifactStorageRoot("health", defaultDataDir());
    fs.mkdirSync(root, { recursive: true });
    const s = performance.now();
    const probe = path.join(root, ".health");
    const stamp = String(Date.now());
    fs.writeFileSync(probe, stamp);
    const ok = fs.readFileSync(probe, "utf-8") === stamp;
    checks.push({ id: "storage", name: "Object Storage", status: ok ? "operational" : "degraded", detail: ok ? "write/read ok" : "read-back mismatch", latencyMs: Math.round(performance.now() - s) });
  } catch {
    checks.push({ id: "storage", name: "Object Storage", status: "down", detail: "not writable" });
  }
  for (const c of sandboxHealthChecks()) checks.push(c);
  const providers = providerHealthSnapshot();
  const cooling = providers.filter((p) => p.coolingDown).length;
  checks.push({ id: "routing", name: "Provider Routing", status: providers.length && cooling === providers.length ? "down" : cooling ? "degraded" : "operational", detail: providers.length ? `${providers.length - cooling}/${providers.length} providers healthy` : "no provider errors recorded" });
  const status = checks.some((c) => c.status === "down") ? "down" : checks.some((c) => c.status === "degraded") ? "degraded" : "operational";
  return { status, checks };
}

/**
 * Execution sandboxes, per provider, from what the workers report and what
 * the registry recorded in the last 24 h. Internal only.
 */
function sandboxHealthChecks(): Check[] {
  const out: Check[] = [];
  const reports = workerRuntimeReports().filter((w) => w.status !== "offline" && w.sandboxRuntime);
  let stats: ReturnType<ReturnType<typeof sandboxRegistry>["stats"]>["byProvider"] | null = null;
  try { stats = sandboxRegistry().stats(86_400_000).byProvider; } catch { stats = null; }
  for (const [id, name] of [["docker", "Sandbox runtime: Docker"], ["openshell", "Sandbox runtime: OpenShell gateway"]] as const) {
    const rs = reports.map((w) => w.sandboxRuntime![id]).filter((r) => r && r.enabled);
    const st = stats?.[id];
    const numbers = st ? ` · ${st.active} active · ${st.failed} failed/24 h${st.avgProvisionMs !== null ? ` · provision ${st.avgProvisionMs} ms avg` : ""}${st.policyDenials ? ` · ${st.policyDenials} policy denials` : ""}${st.reconnects ? ` · ${st.reconnects} reconnects` : ""}${st.fallbacks ? ` · ${st.fallbacks} fallbacks` : ""}` : "";
    if (!rs.length) {
      out.push({ id: `sandbox-${id}`, name, status: id === "docker" && reports.length ? "down" : "not_configured", detail: id === "openshell" ? `disabled${process.env.OPENSHELL_ENABLED === "true" ? " on workers" : ""}${numbers}` : `no worker reporting${numbers}` });
      continue;
    }
    const healthy = rs.filter((r) => r.health?.healthy).length;
    const latency = rs.map((r) => r.health?.latencyMs).filter((n) => typeof n === "number") as number[];
    const version = rs.find((r) => r.health?.version)?.health?.version;
    out.push({
      id: `sandbox-${id}`, name,
      status: healthy === rs.length ? "operational" : healthy ? "degraded" : "down",
      detail: `${healthy}/${rs.length} worker${rs.length === 1 ? "" : "s"} healthy${version ? ` · v${version}` : ""}${numbers}`,
      ...(latency.length ? { latencyMs: Math.max(...latency) } : {}),
    });
  }
  return out;
}

adminRouter.get("/health", need("read"), wrap(async (req, res) => {
  const h = await healthChecks();
  const providers = can(req.staff!.role, "costs.read") ? providerHealthSnapshot() : [];
  res.json({ ...h, providers, checkedAt: Date.now() });
}));

adminRouter.get("/workers", need("read"), wrap((_req, res) => {
  const tenants = tenantManager.list();
  let running = 0, queued = 0;
  for (const t of tenants) {
    try { const q = (t as any).multiAgentRuntime?.queueStats?.(); running += Number(q?.running ?? 0); queued += Number(q?.queued ?? 0); } catch { /* not loaded */ }
  }
  res.json({ workers: workerStats(), runs: { running, queued, loadedAccounts: tenants.length }, sessions: adminService().sessionStats() });
}));

// ---------- execution runtime (sandboxes) ----------

adminRouter.get("/runtime", need("read"), wrap((_req, res) => {
  const reg = sandboxRegistry();
  const day = 86_400_000;
  const orgName = (orgId: string) => { try { return (staffStore().db.prepare(`SELECT name FROM organizations WHERE id = ?`).get(orgId) as any)?.name ?? null; } catch { return null; } };
  const failures = (reg.db.prepare(`SELECT * FROM execution_sandboxes WHERE state = 'failed' OR fallback_reason IS NOT NULL ORDER BY updated_at DESC LIMIT 25`).all() as any[])
    .map((r) => ({ id: r.id, provider: r.provider, tenantId: r.tenant_id, customer: adminService().orgByTenant(r.tenant_id)?.name ?? null, state: r.state, error: r.last_error, fallback: r.fallback_reason, at: r.updated_at }));
  res.json({
    config: {
      mode: (process.env.ORVYN_EXECUTION_PROVIDER || "docker").toLowerCase(),
      openshellEnabled: process.env.OPENSHELL_ENABLED === "true",
      canaryOrgs: String(process.env.OPENSHELL_CANARY_ORGS ?? "").split(",").filter(Boolean).length,
      canaryPercent: Number(process.env.OPENSHELL_CANARY_PERCENT ?? 0),
      acceptancePassed: process.env.OPENSHELL_ACCEPTANCE_PASSED === "true",
    },
    workers: workerRuntimeReports(),
    stats: reg.stats(day).byProvider,
    active: reg.active().slice(0, 50).map((r) => ({ id: r.id, provider: r.provider, tenantId: r.tenantId, customer: adminService().orgByTenant(r.tenantId)?.name ?? null, state: r.state, policy: `${r.policyTemplate}.v${r.policyVersion}`, retention: r.retention, createdAt: r.createdAt })),
    failures,
    flags: reg.flags(OPENSHELL_FLAG).map((f) => ({ ...f, name: f.scope === "org" ? orgName(f.scopeId) : null })),
    pendingRequests: reg.policyRequests({ status: "pending", limit: 50 }).map((r) => ({ ...r, customer: orgName(r.organizationId) })),
    audit: reg.auditLog({ limit: 60 }),
    denials24h: reg.countAudit("network.denied", day),
  });
}));

adminRouter.put("/runtime/flags", need("staff.manage"), wrap((req: AdminRequest, res) => {
  const scope = req.body?.scope === "project" ? "project" : req.body?.scope === "org" ? "org" : null;
  const scopeId = String(req.body?.scopeId ?? "").trim();
  if (!scope || !scopeId || typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "scope (org|project), scopeId and enabled are required." });
  if (scope === "org") {
    const exists = staffStore().db.prepare(`SELECT id FROM organizations WHERE id = ?`).get(scopeId);
    if (!exists) return res.status(404).json({ error: "No such organization." });
  }
  sandboxRegistry().setFlag(scope, scopeId, OPENSHELL_FLAG, req.body.enabled, `staff:${req.staff!.email}`);
  sandboxRegistry().audit("runtime.flag", `staff:${req.staff!.email}`, { organizationId: scope === "org" ? scopeId : null, detail: { scope, scopeId, flag: OPENSHELL_FLAG, enabled: req.body.enabled } });
  audit(req, "runtime.flag", null, { scope, scopeId, flag: OPENSHELL_FLAG, enabled: req.body.enabled });
  res.json({ ok: true });
}));

adminRouter.post("/runtime/requests/:id", need("support.write"), wrap((req: AdminRequest, res) => {
  if (typeof req.body?.approve !== "boolean") return res.status(400).json({ error: "approve must be true or false." });
  try {
    const out = decideRequest(sandboxRegistry(), req.params.id, req.body.approve, `staff:${req.staff!.email}`);
    if (!out) return res.status(404).json({ error: "No such request." });
    audit(req, req.body.approve ? "runtime.request.approve" : "runtime.request.deny", null, { requestId: out.id, template: out.template });
    res.json({ request: out });
  } catch (err: any) { res.status(400).json({ error: String(err?.message ?? err) }); }
}));

/** A customer's sandboxes. Viewing is itself audited (admin sandbox access). */
adminRouter.get("/customers/:id/sandboxes", need("read"), wrap((req: AdminRequest, res) => {
  const id = customerOr404(req, res); if (!id) return;
  const org = adminService().orgByTenant(id)!;
  const reg = sandboxRegistry();
  reg.audit("admin.sandbox.access", `staff:${req.staff!.email}`, { organizationId: org.id, detail: { tenantId: id } });
  res.json({
    runtimeFlag: reg.flag("org", org.id, OPENSHELL_FLAG),
    organizationId: org.id,
    sandboxes: reg.listForTenant(id, 50),
    requests: reg.policyRequests({ organizationId: org.id, limit: 25 }),
    audit: reg.auditLog({ organizationId: org.id, limit: 50 }),
  });
}));

/** Backups: the status the host's backup timer writes into the data volume (no host or bucket names). */
adminRouter.get("/backups", need("read"), wrap((_req, res) => {
  const dir = path.join(defaultDataDir(), ".ops");
  const read = (f: string) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch { return null; } };
  const backup = read("backup-status.json");
  const drill = read("restore-drill.json");
  const history = read("backup-history.json");
  res.json({ backup, drill, history: Array.isArray(history) ? history.slice(-48).reverse() : [], visible: Boolean(backup || drill) });
}));

adminRouter.get("/audit", need("read"), wrap((req, res) => {
  const rows = staffStore().auditLog({ action: req.query.action ? String(req.query.action) : undefined, actor: req.query.actor ? String(req.query.actor) : undefined, tenantId: req.query.tenant ? String(req.query.tenant) : undefined, before: req.query.before ? num(req.query.before, 0) : undefined, limit: num(req.query.limit, 50) });
  res.json({ audit: rows.map((r) => ({ ...r, title: AUDIT_TITLES[r.action] ?? r.action, customer: r.tenantId ? adminService().orgByTenant(r.tenantId)?.name ?? null : null })) });
}));

// ---------- staff ----------

adminRouter.get("/staff", need("read"), wrap((_req, res) => {
  res.json({ staff: staffStore().listStaff(), roles: STAFF_ROLES, suspendCategories: SUSPEND_CATEGORIES });
}));

adminRouter.post("/staff", need("staff.manage"), wrap((req, res) => {
  const role = String(req.body?.role ?? "") as StaffRole;
  const m = staffStore().setStaff(String(req.body?.email ?? ""), role, req.staff!.email);
  audit(req, "staff.set", null, { email: m.email, role });
  res.json({ member: m });
}));

adminRouter.delete("/staff/:userId", need("staff.manage"), wrap((req, res) => {
  if (req.params.userId === req.staff!.id) return res.status(409).json({ error: "You can't remove yourself." });
  const member = staffStore().listStaff().find((s) => s.userId === req.params.userId);
  if (!member) return res.status(404).json({ error: "Not staff." });
  staffStore().removeStaff(member.userId);
  audit(req, "staff.remove", null, { email: member.email });
  res.json({ ok: true });
}));

// Nothing under /admin falls through to the customer API.
adminRouter.use((_req, res) => res.status(404).json({ error: "Not found" }));

