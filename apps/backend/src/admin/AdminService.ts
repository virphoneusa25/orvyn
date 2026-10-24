import { stripeStore as sqliteStripeStore } from "../billing/stripe";
import { paymentStore as stripeStore } from "../billing/AsyncFinancialStores";
// apps/backend/src/admin/AdminService.ts
//
// Read models for the ORVYN Admin Portal. Nothing here writes customer data:
// balances come from the append-only ledger (billing.sqlite), subscriptions
// from the wallet + Stripe store (payments.sqlite), identity from auth.db.
//
// One read connection to auth.db ATTACHes the billing and payment databases
// so a customer page is ONE paged SQL query (no "load every customer").

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultDataDir } from "../persistence/LocalStore";
import { creditLedger } from "../billing/AsyncFinancialStores";

import { PLANS, planById, type PlanId } from "../billing/plans";
import { staffStore as sqliteStaffStore } from "./staffStore";
import { staffStore } from "../auth/AsyncAccountStores";

const DAY = 86_400_000;
export type CustomerStatus = "active" | "past_due" | "trial" | "cancelled" | "paused";
export const CUSTOMER_FILTERS = ["all", "active", "past_due", "trial", "cancelled", "enterprise", "paused", "paid"] as const;
export type CustomerFilter = (typeof CUSTOMER_FILTERS)[number];

/** A credit is sold at $1 per 1,000 (the 10K pack); used to value usage against provider cost. */
export const CREDIT_VALUE_USD = 0.001;

export function statusOf(paused: boolean, subscriptionStatus: string | null | undefined): CustomerStatus {
  if (paused) return "paused";
  const s = String(subscriptionStatus ?? "none");
  if (s === "past_due" || s === "unpaid") return "past_due";
  if (s === "trialing") return "trial";
  if (s === "canceled") return "cancelled";
  return "active";
}

const STATUS_SQL: Record<CustomerFilter, string> = {
  all: "1=1",
  active: "s.at IS NULL AND COALESCE(w.subscription_status,'none') NOT IN ('past_due','unpaid','trialing','canceled')",
  past_due: "s.at IS NULL AND w.subscription_status IN ('past_due','unpaid')",
  trial: "s.at IS NULL AND w.subscription_status = 'trialing'",
  cancelled: "s.at IS NULL AND w.subscription_status = 'canceled'",
  enterprise: "w.plan_id = 'enterprise'",
  paused: "s.at IS NOT NULL",
  paid: "COALESCE(w.plan_id,'free') <> 'free'",
};

/** Which bucket of spend a usage lane belongs to (the provider-cost chart). */
export function costClass(lane: string, type: string): string {
  if (type === "image" || /image/.test(lane)) return "Vision & images";
  if (/deep|advanced|ultra/.test(lane)) return "Reasoning";
  if (/build|server|code/.test(lane)) return "Code";
  if (/search|compute/.test(lane) || type === "search" || type === "compute") return "Research & tools";
  return "Text models";
}

function monthlyPriceUsd(planId: string, period: "monthly" | "yearly" | null): number {
  const p = planById(planId);
  if (period === "yearly" && p.priceAnnualUsd) return p.priceAnnualUsd / 12;
  return p.priceMonthlyUsd ?? 0;
}

function pctChange(now: number, before: number): number | null {
  if (!before) return now ? null : 0;
  return Math.round(((now - before) / before) * 1000) / 10;
}

function days(n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(now - i * DAY).toISOString().slice(0, 10));
  return out;
}

export class AdminService {
  private db: DatabaseSync;
  private dataDir: string;

  constructor(dataDir: string = defaultDataDir()) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    sqliteStaffStore(); // Local reporting still attaches the SQLite billing/payment stores.
    void require("../billing/creditLedgerInstance").creditLedger; // Keep the existing SQLite report schema initialized.
    sqliteStripeStore(); // Keep the attached payment schema initialized.
    this.db = new DatabaseSync(path.join(dataDir, "auth.db"));
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(`ATTACH DATABASE '${path.join(dataDir, "billing.sqlite").replace(/'/g, "''")}' AS b`);
    this.db.exec(`ATTACH DATABASE '${path.join(dataDir, "payments.sqlite").replace(/'/g, "''")}' AS p`);
  }

  // ---------- customers (paged) ----------

  async customers(opts: { q?: string; filter?: CustomerFilter; page?: number; pageSize?: number; sort?: string }) {
    const filter = CUSTOMER_FILTERS.includes(opts.filter as CustomerFilter) ? (opts.filter as CustomerFilter) : "all";
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const page = Math.max(1, opts.page ?? 1);
    const where = [STATUS_SQL[filter]];
    const args: (string | number)[] = [];
    const q = (opts.q ?? "").trim().toLowerCase();
    if (q) {
      where.push(`(lower(o.name) LIKE ? OR o.id = ? OR o.tenant_id = ? OR EXISTS (SELECT 1 FROM organization_members mm JOIN users uu ON uu.id = mm.user_id WHERE mm.organization_id = o.id AND (lower(uu.email) LIKE ? OR lower(COALESCE(uu.name,'')) LIKE ?)) OR EXISTS (SELECT 1 FROM p.stripe_customers sc WHERE sc.account_id = o.tenant_id AND sc.customer_id = ?) OR w.subscription_id = ?)`);
      args.push(`%${q}%`, opts.q!.trim(), opts.q!.trim(), `%${q}%`, `%${q}%`, opts.q!.trim(), opts.q!.trim());
    }
    const from = `FROM organizations o
      LEFT JOIN b.wallets w ON w.account_id = o.tenant_id
      LEFT JOIN account_suspensions s ON s.tenant_id = o.tenant_id AND s.lifted_at IS NULL
      WHERE ${where.join(" AND ")}`;
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...args) as { n: number }).n);
    const order = opts.sort === "name" ? "lower(o.name) ASC" : opts.sort === "renewal" ? "COALESCE(w.cycle_end, 9e15) ASC" : "o.created_at DESC";
    const rows = this.db.prepare(`SELECT o.id AS org_id, o.name, o.kind, o.tenant_id, o.created_at,
        w.plan_id, w.subscription_status, w.subscription_id, w.cycle_end, s.at AS paused_at,
        (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS members
      ${from} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as any[];
    return { total, page, pageSize, customers: (await Promise.all(rows.map(async (r) => (await this.row(r))))), counts: this.counts() };
  }

  private contact(orgId: string): { userId: string; email: string; name: string | null } | null {
    const r = this.db.prepare(`SELECT u.id, u.email, u.name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.created_at LIMIT 1`).get(orgId) as any;
    return r ? { userId: r.id, email: r.email, name: r.name ?? null } : null;
  }

  private async row(r: any) {
    const w = (await creditLedger.snapshot(r.tenant_id));
    const plan = planById(r.plan_id ?? w.plan.id);
    const status = statusOf(Boolean(r.paused_at), r.subscription_status ?? w.subscription?.status);
    const manual = String(r.subscription_id ?? "").startsWith("manual:");
    const contact = this.contact(r.org_id);
    // A personal workspace is named "Personal" — show whose it is.
    const name = r.kind !== "company" && /^personal( workspace)?$/i.test(String(r.name)) && contact ? (contact.name || contact.email) : String(r.name);
    return {
      id: String(r.tenant_id), organizationId: String(r.org_id), name, kind: r.kind === "company" ? "company" : "personal",
      contact, members: Number(r.members ?? 0), createdAt: Number(r.created_at),
      plan: { id: plan.id, label: plan.label, priceMonthlyUsd: plan.priceMonthlyUsd },
      complimentary: manual && plan.id !== "free",
      status, subscriptionStatus: String(r.subscription_status ?? "none"),
      creditsRemaining: w.availableBalance, monthlyAllowance: w.windows.cycle.limit + w.purchasedBalance,
      monthlyUsage: { used: w.windows.cycle.used, limit: w.windows.cycle.limit },
      renewalAt: plan.id !== "free" && !manual ? w.subscription?.cycleEnd ?? null : null,
      cycleEnd: w.subscription?.cycleEnd ?? null,
    };
  }

  counts(): Record<CustomerFilter, number> {
    const out = {} as Record<CustomerFilter, number>;
    for (const f of CUSTOMER_FILTERS) {
      out[f] = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM organizations o LEFT JOIN b.wallets w ON w.account_id = o.tenant_id LEFT JOIN account_suspensions s ON s.tenant_id = o.tenant_id AND s.lifted_at IS NULL WHERE ${STATUS_SQL[f]}`).get() as { n: number }).n);
    }
    return out;
  }

  orgByTenant(tenantId: string): { id: string; name: string; kind: string; tenantId: string; createdAt: number } | null {
    const r = this.db.prepare(`SELECT * FROM organizations WHERE tenant_id = ?`).get(tenantId) as any;
    if (!r) return null;
    let name = String(r.name);
    if (r.kind !== "company" && /^personal( workspace)?$/i.test(name)) { const c = this.contact(r.id); if (c) name = c.name || c.email; }
    return { id: r.id, name, kind: r.kind, tenantId: r.tenant_id, createdAt: r.created_at };
  }

  // ---------- one customer ----------

  async customer(tenantId: string) {
    const r = this.db.prepare(`SELECT o.id AS org_id, o.name, o.kind, o.tenant_id, o.created_at, w.plan_id, w.subscription_status, w.subscription_id, w.cycle_end, s.at AS paused_at,
      (SELECT COUNT(*) FROM organization_members m WHERE m.organization_id = o.id) AS members
      FROM organizations o LEFT JOIN b.wallets w ON w.account_id = o.tenant_id LEFT JOIN account_suspensions s ON s.tenant_id = o.tenant_id AND s.lifted_at IS NULL
      WHERE o.tenant_id = ?`).get(tenantId) as any;
    if (!r) return null;
    const base = (await this.row(r));
    const wallet = (await creditLedger.snapshot(tenantId));
    const members = (this.db.prepare(`SELECT u.id, u.email, u.name, u.created_at, u.email_verified_at, m.role, m.created_at AS joined,
        (SELECT MAX(COALESCE(last_used_at, created_at)) FROM sessions se WHERE se.user_id = u.id) AS last_seen
      FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at`).all(r.org_id) as any[])
      .map((m) => ({ userId: m.id, email: m.email, name: m.name ?? null, role: m.role, joinedAt: m.joined, verified: m.email_verified_at != null, lastSeenAt: m.last_seen ?? null }));
    const store = stripeStore();
    const sub = (await store.latestSubscription(tenantId));
    const now = Date.now();
    const sum = (from: number, to: number) => Number((this.db.prepare(`SELECT COALESCE(SUM(credits_charged),0) AS n FROM b.usage_events WHERE user_id = ? AND ok = 1 AND created_at >= ? AND created_at < ?`).get(tenantId, from, to) as { n: number }).n);
    const cycleStart = wallet.subscription?.cycleStart ?? now - 30 * DAY;
    const cycleLen = Math.max(DAY, (wallet.subscription?.cycleEnd ?? now) - cycleStart);
    const topups = this.db.prepare(`SELECT meta FROM b.ledger_entries WHERE account_id = ? AND type = 'topup_purchase'`).all(tenantId) as { meta: string }[];
    const topupUsd = topups.reduce((s, t) => { try { return s + Number(JSON.parse(t.meta).priceUsd ?? 0); } catch { return s; } }, 0);
    const suspension = (await staffStore().suspension(tenantId));
    const plan = planById(wallet.plan.id);
    const tags: string[] = [];
    if (plan.id === "enterprise" || plan.id === "team") tags.push("Enterprise Customer");
    if (wallet.windows.sevenDay.limit && wallet.windows.sevenDay.used / wallet.windows.sevenDay.limit >= 0.8) tags.push("High Usage");
    if (base.status === "past_due") tags.push("Past Due");
    if (suspension) tags.push("Paused");
    if (base.complimentary) tags.push("Complimentary");
    return {
      ...base,
      tags,
      since: Number(r.created_at),
      profile: (await staffStore().profile(tenantId)),
      team: members,
      wallet: {
        planId: wallet.plan.id, included: wallet.includedBalance, purchased: wallet.purchasedBalance, reserved: wallet.reservedBalance, available: wallet.availableBalance,
        windows: wallet.windows, autoRecharge: wallet.autoRecharge ?? null, cycleStart: wallet.subscription?.cycleStart ?? null, cycleEnd: wallet.subscription?.cycleEnd ?? null,
      },
      usageCompare: {
        cycle: { now: sum(cycleStart, now), before: sum(cycleStart - cycleLen, cycleStart) },
        fiveHour: { now: sum(now - 5 * 3_600_000, now), before: sum(now - 10 * 3_600_000, now - 5 * 3_600_000) },
        sevenDay: { now: sum(now - 7 * DAY, now), before: sum(now - 14 * DAY, now - 7 * DAY) },
      },
      stripe: {
        customerId: (await store.customerOf(tenantId)),
        subscriptionId: sub?.subscription_id ?? (String(r.subscription_id ?? "").startsWith("manual:") ? null : r.subscription_id ?? null),
        subscriptionStatus: sub?.status ?? null,
        cancelAtPeriodEnd: Boolean(sub?.cancel_at_period_end),
        period: sub ? (await store.periodOf(sub.subscription_id)) : null,
      },
      topupSpendUsd: Math.round(topupUsd * 100) / 100,
      suspension,
      notes: (await staffStore().notes(tenantId, 20)),
      supportNotesCount: (await staffStore().notes(tenantId, 500)).length,
    };
  }

  /** Daily series for one customer (or everyone): credits, tokens, provider cost, runs, chat turns. */
  usageSeries(tenantId: string | null, nDays = 30, now = Date.now()) {
    const from = now - nDays * DAY;
    const rows = this.db.prepare(`SELECT substr(datetime(created_at/1000,'unixepoch'),1,10) AS day,
        SUM(credits_charged) AS credits, SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) AS tokens, SUM(provider_cost_micros) AS cost,
        COUNT(DISTINCT run_id) AS missions, SUM(CASE WHEN run_id IS NULL THEN 1 ELSE 0 END) AS chat
      FROM b.usage_events WHERE ok = 1 AND created_at >= ? ${tenantId ? "AND user_id = ?" : ""} GROUP BY day`).all(...(tenantId ? [from, tenantId] : [from])) as any[];
    const by = new Map(rows.map((r) => [r.day, r]));
    return days(nDays, now).map((d) => {
      const r = by.get(d);
      return { day: d, credits: Number(r?.credits ?? 0), tokens: Number(r?.tokens ?? 0), costUsd: Number(r?.cost ?? 0) / 1e6, missions: Number(r?.missions ?? 0), chat: Number(r?.chat ?? 0) };
    });
  }

  projects(tenantId: string) {
    return (this.db.prepare(`SELECT p.id, p.name, p.project_root, p.created_at, u.email AS owner FROM tenant_projects p LEFT JOIN users u ON u.id = p.user_id WHERE p.tenant_id = ? ORDER BY p.created_at DESC LIMIT 200`).all(tenantId) as any[])
      .map((p) => ({ id: p.id, name: p.name, type: p.project_root ? "Desktop project" : "Cloud project", createdAt: p.created_at, owner: p.owner ?? null }));
  }

  /** The customer's session database, opened read-only (never loads their runtime). */
  private sessionsDb<T>(tenantId: string, fn: (db: DatabaseSync) => T, fallback: T): T {
    if (!/^[A-Za-z0-9_-]+$/.test(tenantId)) return fallback;
    const file = path.join(this.dataDir, `${tenantId}-sessions.db`);
    if (!fs.existsSync(file)) return fallback;
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(file, { readOnly: true } as any);
      return fn(db);
    } catch {
      return fallback;
    } finally {
      try { db?.close(); } catch { /* closed */ }
    }
  }

  workspaces(tenantId: string) {
    const projectNames = new Map(this.projects(tenantId).map((p) => [p.id, p.name]));
    return this.sessionsDb(tenantId, (db) => (db.prepare(`SELECT workspace_id, project_id, project_root, created_at FROM workspaces ORDER BY created_at DESC LIMIT 200`).all() as any[])
      .map((w) => ({ id: w.workspace_id, name: projectNames.get(w.project_id) ?? path.basename(String(w.project_root).replace(/\\/g, "/")) ?? "Workspace", projectId: w.project_id, createdAt: w.created_at })), []);
  }

  /** Conversations and missions with the credits each used. Titles only — never message content. */
  chats(tenantId: string, limit = 50) {
    const projectNames = new Map(this.projects(tenantId).map((p) => [p.id, p.name]));
    const list = this.sessionsDb(tenantId, (db) => db.prepare(`SELECT session_id, title, project_id, project_root, run_ids_json, created_at, updated_at FROM work_sessions ORDER BY updated_at DESC LIMIT ?`).all(limit) as any[], [] as any[]);
    const credits = new Map((this.db.prepare(`SELECT session_id, SUM(credits_charged) AS n FROM b.usage_events WHERE user_id = ? AND session_id IS NOT NULL GROUP BY session_id`).all(tenantId) as any[]).map((r) => [r.session_id, Number(r.n)]));
    return list.map((s) => {
      const runs = (() => { try { return JSON.parse(s.run_ids_json).length; } catch { return 0; } })();
      return { id: s.session_id, title: s.title, project: s.project_id ? projectNames.get(s.project_id) ?? "Project" : s.project_root ? path.basename(String(s.project_root).replace(/\\/g, "/")) : null, kind: runs ? "mission" : "chat", credits: credits.get(s.session_id) ?? 0, updatedAt: s.updated_at };
    });
  }

  /** Account activity timeline (credits, projects, payments, plan, team, staff actions). */
  async activity(tenantId: string | null, limit = 30) {
    type Item = { at: number; kind: string; title: string; detail: string; tenantId?: string | null; customer?: string | null };
    const items: Item[] = [];
    const t = tenantId ? "AND account_id = ?" : "";
    const a = tenantId ? [tenantId] : [];
    for (const e of this.db.prepare(`SELECT account_id, type, amount, actor, meta, created_at FROM b.ledger_entries WHERE type IN ('monthly_grant','topup_purchase','admin_adjustment','refund') ${t} ORDER BY seq DESC LIMIT 60`).all(...a) as any[]) {
      let meta: any = {}; try { meta = JSON.parse(e.meta); } catch { /* */ }
      if (e.type === "topup_purchase") items.push({ at: e.created_at, kind: "payment", title: "Payment received", detail: `${Number(e.amount).toLocaleString("en-US")} credits · $${Number(meta.priceUsd ?? 0).toFixed(2)}`, tenantId: e.account_id });
      else if (e.type === "monthly_grant") items.push({ at: e.created_at, kind: String(meta.subscriptionId ?? "").startsWith("manual:") || !meta.subscriptionId ? "plan" : "invoice", title: meta.reason === "subscription_ended" ? "Plan ended" : "Plan renewed", detail: `${planById(String(meta.plan ?? "free")).label} · ${Number(e.amount).toLocaleString("en-US")} credits`, tenantId: e.account_id });
      else if (e.type === "admin_adjustment") items.push({ at: e.created_at, kind: "adjustment", title: e.amount > 0 ? "Credits granted" : "Credits removed", detail: `${e.amount > 0 ? "+" : ""}${Number(e.amount).toLocaleString("en-US")} · ${meta.reason ?? ""} · ${e.actor ?? ""}`, tenantId: e.account_id });
      else if (e.type === "refund") items.push({ at: e.created_at, kind: "refund", title: "Refund", detail: `${Number(e.amount).toLocaleString("en-US")} credits`, tenantId: e.account_id });
    }
    const usage = this.db.prepare(`SELECT user_id, substr(datetime(created_at/1000,'unixepoch'),1,10) AS day, SUM(credits_charged) AS n, MAX(created_at) AS at FROM b.usage_events WHERE ok = 1 ${tenantId ? "AND user_id = ?" : ""} GROUP BY user_id, day ORDER BY at DESC LIMIT 30`).all(...a) as any[];
    for (const u of usage) if (Number(u.n) > 0) items.push({ at: u.at, kind: "usage", title: "Credits used", detail: `${Number(u.n).toLocaleString("en-US")} credits on ${u.day}`, tenantId: u.user_id });
    for (const p of this.db.prepare(`SELECT tenant_id, name, created_at FROM tenant_projects ${tenantId ? "WHERE tenant_id = ?" : ""} ORDER BY created_at DESC LIMIT 30`).all(...a) as any[]) items.push({ at: p.created_at, kind: "project", title: "New project created", detail: p.name, tenantId: p.tenant_id });
    for (const m of this.db.prepare(`SELECT o.tenant_id, u.email, m.created_at, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id JOIN users u ON u.id = m.user_id ${tenantId ? "WHERE o.tenant_id = ?" : ""} ORDER BY m.created_at DESC LIMIT 30`).all(...a) as any[]) items.push({ at: m.created_at, kind: "team", title: m.role === "owner" ? "Account created" : "Team member added", detail: m.email, tenantId: m.tenant_id });
    for (const x of (await staffStore().auditLog({ tenantId: tenantId ?? undefined, limit: 40 }))) if (x.tenantId) items.push({ at: x.at, kind: "support", title: AUDIT_TITLES[x.action] ?? x.action, detail: `${x.actorEmail}${x.detail?.reason ? ` · ${String(x.detail.reason).slice(0, 80)}` : ""}`, tenantId: x.tenantId });
    items.sort((x, y) => y.at - x.at);
    const out = items.slice(0, limit);
    if (!tenantId) for (const i of out) i.customer = i.tenantId ? this.orgByTenant(i.tenantId)?.name ?? null : null;
    return out;
  }

  // ---------- platform metrics ----------

  async dashboard(now = Date.now()) {
    const n = (sql: string, ...args: (string | number)[]) => Number((this.db.prepare(sql).get(...args) as { n: number }).n ?? 0);
    const users = n(`SELECT COUNT(*) AS n FROM users`);
    const users30 = n(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ?`, now - 30 * DAY);
    const usersPrev = n(`SELECT COUNT(*) AS n FROM users WHERE created_at >= ? AND created_at < ?`, now - 60 * DAY, now - 30 * DAY);
    const orgs = n(`SELECT COUNT(*) AS n FROM organizations`);
    const paidRows = this.db.prepare(`SELECT w.account_id, w.plan_id, w.subscription_id, w.subscription_status FROM b.wallets w JOIN organizations o ON o.tenant_id = w.account_id
      WHERE w.plan_id <> 'free' AND w.subscription_id IS NOT NULL AND w.subscription_id NOT LIKE 'manual:%' AND w.subscription_status IN ('active','trialing','past_due')`).all() as any[];
    const store = stripeStore();
    const byPlan = new Map<string, { plan: string; label: string; customers: number; mrr: number }>();
    let mrr = 0;
    for (const r of paidRows) {
      const v = monthlyPriceUsd(r.plan_id, (await store.periodOf(r.subscription_id)));
      mrr += v;
      const k = byPlan.get(r.plan_id) ?? { plan: r.plan_id, label: planById(r.plan_id).label, customers: 0, mrr: 0 };
      k.customers++; k.mrr += v;
      byPlan.set(r.plan_id, k);
    }
    const planOrder = Object.keys(PLANS);
    const revenueByPlan = [...byPlan.values()].sort((x, y) => y.mrr - x.mrr).map((x) => ({ ...x, mrr: Math.round(x.mrr * 100) / 100, share: mrr ? Math.round((x.mrr / mrr) * 1000) / 10 : 0 }));
    // Paid customers who started in the last 30 days (their first paid grant).
    const newPaid = n(`SELECT COUNT(*) AS n FROM (SELECT account_id, MIN(created_at) AS first FROM b.ledger_entries WHERE type = 'monthly_grant' AND meta NOT LIKE '%"plan":"free"%' AND meta NOT LIKE '%manual:%' GROUP BY account_id) WHERE first >= ?`, now - 30 * DAY);
    const subs = this.db.prepare(`SELECT subscription_status AS s, COUNT(*) AS n FROM b.wallets WHERE subscription_id IS NOT NULL AND subscription_id NOT LIKE 'manual:%' GROUP BY subscription_status`).all() as { s: string; n: number }[];
    const subCount = (k: string[]) => subs.filter((x) => k.includes(x.s)).reduce((a, x) => a + Number(x.n), 0);
    const active = subCount(["active", "trialing"]), pastDue = subCount(["past_due", "unpaid"]), cancelled = subCount(["canceled"]);
    const subTotal = active + pastDue + cancelled;
    const credits30 = n(`SELECT COALESCE(SUM(credits_charged),0) AS n FROM b.usage_events WHERE ok = 1 AND created_at >= ?`, now - 30 * DAY);
    const creditsPrev = n(`SELECT COALESCE(SUM(credits_charged),0) AS n FROM b.usage_events WHERE ok = 1 AND created_at >= ? AND created_at < ?`, now - 60 * DAY, now - 30 * DAY);
    const signupRows = new Map((this.db.prepare(`SELECT substr(datetime(created_at/1000,'unixepoch'),1,10) AS day, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY day`).all(now - 30 * DAY) as any[]).map((r) => [r.day, Number(r.n)]));
    const costs = this.providerCosts(30, now);
    return {
      generatedAt: now,
      totalUsers: { value: users, new30d: users30, change: pctChange(users30, usersPrev) },
      paidCustomers: { value: paidRows.length, conversion: orgs ? Math.round((paidRows.length / orgs) * 1000) / 10 : 0, new30d: newPaid },
      mrr: { value: Math.round(mrr * 100) / 100, arr: Math.round(mrr * 12 * 100) / 100 },
      creditsUsed: { value: credits30, change: pctChange(credits30, creditsPrev) },
      subscriptions: { total: subTotal, active, pastDue, cancelled, pct: { active: subTotal ? Math.round((active / subTotal) * 1000) / 10 : 0, pastDue: subTotal ? Math.round((pastDue / subTotal) * 1000) / 10 : 0, cancelled: subTotal ? Math.round((cancelled / subTotal) * 1000) / 10 : 0 } },
      revenueByPlan: revenueByPlan.sort((x, y) => planOrder.indexOf(y.plan) - planOrder.indexOf(x.plan)).sort((x, y) => y.mrr - x.mrr),
      creditTrend: this.usageSeries(null, 30, now).map((d) => ({ day: d.day, credits: d.credits })),
      signups: { total30d: users30, change: pctChange(users30, usersPrev), days: days(30, now).map((d) => ({ day: d, count: signupRows.get(d) ?? 0 })) },
      providerCosts: { totalUsd: costs.totalUsd, byClass: costs.byClass },
      activity: (await this.activity(null, 8)),
    };
  }

  /** Internal provider/model costs vs the credits charged for them (admin only; vendor names allowed here). */
  providerCosts(nDays = 30, now = Date.now()) {
    const rows = this.db.prepare(`SELECT COALESCE(provider,'unknown') AS provider, COALESCE(model,'unknown') AS model, COALESCE(lane,'auto') AS lane, type,
        COUNT(*) AS calls, SUM(COALESCE(input_tokens,0)) AS input, SUM(COALESCE(output_tokens,0)) AS output, SUM(provider_cost_micros) AS cost, SUM(credits_charged) AS credits
      FROM b.usage_events WHERE ok = 1 AND created_at >= ? GROUP BY provider, model, lane, type ORDER BY cost DESC`).all(now - nDays * DAY) as any[];
    const byModel = new Map<string, { provider: string; model: string; calls: number; tokens: number; costUsd: number; credits: number }>();
    const byClass = new Map<string, number>();
    let totalUsd = 0, totalCredits = 0;
    for (const r of rows) {
      const cost = Number(r.cost ?? 0) / 1e6;
      totalUsd += cost; totalCredits += Number(r.credits ?? 0);
      const k = `${r.provider}|${r.model}`;
      const m = byModel.get(k) ?? { provider: r.provider, model: r.model, calls: 0, tokens: 0, costUsd: 0, credits: 0 };
      m.calls += Number(r.calls); m.tokens += Number(r.input) + Number(r.output); m.costUsd += cost; m.credits += Number(r.credits ?? 0);
      byModel.set(k, m);
      const c = costClass(String(r.lane), String(r.type));
      byClass.set(c, (byClass.get(c) ?? 0) + cost);
    }
    const models = [...byModel.values()].sort((a, b) => b.costUsd - a.costUsd).map((m) => {
      const value = m.credits * CREDIT_VALUE_USD;
      return { ...m, costUsd: Math.round(m.costUsd * 10000) / 10000, creditValueUsd: Math.round(value * 100) / 100, marginPct: value ? Math.round(((value - m.costUsd) / value) * 1000) / 10 : null };
    });
    const daily = this.usageSeries(null, nDays, now).map((d) => ({ day: d.day, costUsd: Math.round(d.costUsd * 10000) / 10000, creditValueUsd: Math.round(d.credits * CREDIT_VALUE_USD * 100) / 100 }));
    const value = totalCredits * CREDIT_VALUE_USD;
    return {
      days: nDays, totalUsd: Math.round(totalUsd * 100) / 100, creditValueUsd: Math.round(value * 100) / 100,
      marginPct: value ? Math.round(((value - totalUsd) / value) * 1000) / 10 : null,
      byClass: [...byClass.entries()].sort((a, b) => b[1] - a[1]).map(([name, usd]) => ({ name, usd: Math.round(usd * 100) / 100, share: totalUsd ? Math.round((usd / totalUsd) * 1000) / 10 : 0 })),
      models, daily,
    };
  }

  /** Top credit consumers in a window (Usage & Credits). */
  topConsumers(nDays = 30, page = 1, pageSize = 25, now = Date.now()) {
    const rows = this.db.prepare(`SELECT e.user_id AS tenant_id, SUM(e.credits_charged) AS credits, COUNT(*) AS events, MAX(e.created_at) AS last
      FROM b.usage_events e WHERE e.ok = 1 AND e.created_at >= ? GROUP BY e.user_id ORDER BY credits DESC LIMIT ? OFFSET ?`).all(now - nDays * DAY, pageSize, (page - 1) * pageSize) as any[];
    return rows.map((r) => ({ tenantId: r.tenant_id, name: this.orgByTenant(r.tenant_id)?.name ?? r.tenant_id, credits: Number(r.credits), events: Number(r.events), lastAt: r.last }));
  }

  adjustments(limit = 50) {
    return (this.db.prepare(`SELECT account_id, amount, bucket, actor, meta, created_at FROM b.ledger_entries WHERE type = 'admin_adjustment' AND COALESCE(actor,'') <> 'system:migration' ORDER BY seq DESC LIMIT ?`).all(limit) as any[])
      .map((e) => { let meta: any = {}; try { meta = JSON.parse(e.meta); } catch { /* */ } return { tenantId: e.account_id, customer: this.orgByTenant(e.account_id)?.name ?? e.account_id, credits: Number(e.amount), bucket: e.bucket, actor: e.actor, reason: meta.reason ?? "", category: meta.category ?? null, at: e.created_at }; });
  }

  async ledger(tenantId: string, limit = 100) {
    return (await creditLedger.entries(tenantId, limit)).map((e) => ({ ...e }));
  }

  async subscriptions(opts: { status?: string; page?: number; pageSize?: number }) {
    const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? 25));
    const page = Math.max(1, opts.page ?? 1);
    const where = ["w.subscription_id IS NOT NULL"];
    const args: (string | number)[] = [];
    if (opts.status === "manual") where.push("w.subscription_id LIKE 'manual:%'");
    else if (opts.status) { where.push("w.subscription_status = ? AND w.subscription_id NOT LIKE 'manual:%'"); args.push(opts.status); }
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM b.wallets w WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n);
    const store = stripeStore();
    const rows = (await Promise.all((this.db.prepare(`SELECT w.*, o.name, ps.cancel_at_period_end FROM b.wallets w LEFT JOIN organizations o ON o.tenant_id = w.account_id LEFT JOIN p.stripe_subscriptions ps ON ps.subscription_id = w.subscription_id
      WHERE ${where.map((x) => x.replace(/\bw\./g, "w.")).join(" AND ")} ORDER BY w.cycle_end ASC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize) as any[])
      .map(async (r) => {
        const manual = String(r.subscription_id).startsWith("manual:");
        const period = manual ? null : (await store.periodOf(r.subscription_id));
        return { tenantId: r.account_id, customer: r.name ?? r.account_id, planId: r.plan_id, plan: planById(r.plan_id).label, subscriptionId: manual ? null : r.subscription_id, complimentary: manual, status: r.subscription_status, period, mrr: manual ? 0 : Math.round(monthlyPriceUsd(r.plan_id, period) * 100) / 100, renewsAt: r.cycle_end, cancelAtPeriodEnd: Boolean(r.cancel_at_period_end) };
      })));
    return { total, page, pageSize, subscriptions: rows };
  }

  topups(nDays = 30, now = Date.now()) {
    const rows = this.db.prepare(`SELECT meta, amount FROM b.ledger_entries WHERE type = 'topup_purchase' AND created_at >= ?`).all(now - nDays * DAY) as any[];
    const by = new Map<string, { purchases: number; credits: number; revenueUsd: number }>();
    for (const r of rows) {
      let m: any = {}; try { m = JSON.parse(r.meta); } catch { /* */ }
      const k = String(m.pack ?? "unknown");
      const x = by.get(k) ?? { purchases: 0, credits: 0, revenueUsd: 0 };
      x.purchases++; x.credits += Number(r.amount); x.revenueUsd += Number(m.priceUsd ?? 0);
      by.set(k, x);
    }
    return by;
  }

  /** Global search across users, organizations and subscriptions (invoices are looked up in Stripe by the route). */
  search(q: string, limit = 8) {
    const s = q.trim();
    if (s.length < 2) return { users: [], organizations: [], subscriptions: [] };
    const like = `%${s.toLowerCase()}%`;
    const users = (this.db.prepare(`SELECT u.id, u.email, u.name, o.tenant_id, o.name AS org FROM users u
        LEFT JOIN organization_members m ON m.user_id = u.id LEFT JOIN organizations o ON o.id = m.organization_id
        WHERE lower(u.email) LIKE ? OR lower(COALESCE(u.name,'')) LIKE ? OR u.id = ? GROUP BY u.id LIMIT ?`).all(like, like, s, limit) as any[])
      .map((u) => ({ userId: u.id, email: u.email, name: u.name ?? null, tenantId: u.tenant_id ?? null, organization: u.org ?? null }));
    const organizations = (this.db.prepare(`SELECT id, name, tenant_id, kind FROM organizations WHERE lower(name) LIKE ? OR id = ? OR tenant_id = ? LIMIT ?`).all(like, s, s, limit) as any[])
      .map((o) => ({ organizationId: o.id, tenantId: o.tenant_id, name: o.name, kind: o.kind }));
    const subscriptions = (this.db.prepare(`SELECT w.account_id, w.subscription_id, w.plan_id, w.subscription_status, o.name, sc.customer_id FROM b.wallets w LEFT JOIN organizations o ON o.tenant_id = w.account_id LEFT JOIN p.stripe_customers sc ON sc.account_id = w.account_id
        WHERE w.subscription_id LIKE ? OR sc.customer_id LIKE ? LIMIT ?`).all(`%${s}%`, `%${s}%`, limit) as any[])
      .filter((r) => !String(r.subscription_id ?? "").startsWith("manual:") || r.customer_id)
      .map((r) => ({ tenantId: r.account_id, customer: r.name ?? r.account_id, subscriptionId: String(r.subscription_id ?? "").startsWith("manual:") ? null : r.subscription_id, customerId: r.customer_id ?? null, plan: planById(r.plan_id).label, status: r.subscription_status }));
    return { users, organizations, subscriptions };
  }

  sessionStats(now = Date.now()) {
    const n = (sql: string, ...a: number[]) => Number((this.db.prepare(sql).get(...a) as { n: number }).n ?? 0);
    return {
      signedIn: n(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?`, now),
      active15m: n(`SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND COALESCE(last_used_at, created_at) >= ?`, now, now - 15 * 60_000),
      activeUsers24h: n(`SELECT COUNT(DISTINCT user_id) AS n FROM sessions WHERE COALESCE(last_used_at, created_at) >= ?`, now - DAY),
      viewAs: n(`SELECT COUNT(*) AS n FROM view_as_sessions WHERE expires_at > ?`, now),
    };
  }

  /** Staff-only: who owns this tenant (for password reset / verification / view as). */
  owner(tenantId: string): { userId: string; email: string; name: string | null; organizationId: string } | null {
    const org = this.orgByTenant(tenantId);
    if (!org) return null;
    const c = this.contact(org.id);
    return c ? { ...c, organizationId: org.id } : null;
  }

  /** A database round trip on each store (System Health). */
  ping(): { auth: number; billing: number; payments: number } {
    const t = (fn: () => void) => { const s = performance.now(); fn(); return Math.round((performance.now() - s) * 100) / 100; };
    return {
      auth: t(() => this.db.prepare(`SELECT 1`).get()),
      billing: t(() => this.db.prepare(`SELECT COUNT(*) FROM b.wallets`).get()),
      payments: t(() => this.db.prepare(`SELECT COUNT(*) FROM p.stripe_events`).get()),
    };
  }
}

export const AUDIT_TITLES: Record<string, string> = {
  "credits.adjust": "Admin credit adjustment",
  "account.suspend": "Account paused",
  "account.reactivate": "Account reactivated",
  "support.note": "Support note added",
  "support.password_reset": "Password reset sent",
  "support.resend_verification": "Verification email sent",
  "support.view_as": "Viewed as customer",
  "support.view_as_end": "Ended customer view",
  "plan.change": "Plan changed",
  "plan.schedule": "Plan change scheduled",
  "plan.cancel_at_period_end": "Set to cancel at renewal",
  "plan.resume": "Subscription resumed",
  "plan.complimentary": "Complimentary plan assigned",
  "plan.complimentary_end": "Complimentary plan ended",
  "plan.checkout_link": "Checkout link created",
  "profile.update": "Customer details edited",
  "customer.create": "Customer created by staff",
  "staff.set": "Staff role set",
  "staff.remove": "Staff removed",
};

let shared: AdminService | null = null;
export function adminService(): AdminService {
  if (!shared) shared = new AdminService();
  return shared;
}

export type { PlanId };
