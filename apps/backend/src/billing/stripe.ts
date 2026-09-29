// apps/backend/src/billing/stripe.ts
//
// Payments through Stripe (no SDK: form-encoded REST + webhook signature
// check). The rules this module holds:
//
//  * Only a verified webhook changes paid state. A browser returning from
//    Checkout proves nothing; it only shows "processing".
//  * Every webhook event is recorded once (stripe_events.id is unique) and
//    processed in order of arrival; a replay is acknowledged and ignored.
//  * Credits and plans move only through CreditLedger entries whose
//    idempotency keys come from Stripe ids, so even a re-processed event
//    cannot grant twice.
//  * No card data ever reaches ORVYN; Stripe hosts Checkout and the portal.
//  * Prices come from configured Stripe price ids (STRIPE_PRICE_<PLAN>_<MONTHLY|YEARLY>,
//    STRIPE_PRICE_<PACK>). This module never creates products or prices.
//
// Nothing here logs secrets, card data, or full request bodies.

import { DatabaseSync } from "node:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as path from "path";
import * as fs from "fs";
import { defaultDataDir } from "../persistence/LocalStore";
import { creditLedger as defaultLedger } from "./creditLedgerInstance";
import type { CreditLedger } from "./CreditLedger";
import { CREDIT_PACKS, PLANS, type PackId, type PlanId, packById, planById } from "./plans";

export type Period = "monthly" | "yearly";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  apiBase: string;
  publicOrigin: string;
}

export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (!secretKey) return null;
  return {
    secretKey,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET?.trim() ?? "",
    apiBase: (env.STRIPE_API_BASE?.trim() || "https://api.stripe.com").replace(/\/$/, ""),
    publicOrigin: (env.ORVYN_PUBLIC_ORIGIN?.trim() || "").replace(/\/$/, ""),
  };
}

/** Configured price id for a plan/period or a credit pack (env), or null. */
export function priceIdFor(item: { planId?: string; period?: Period; packId?: string }, env: NodeJS.ProcessEnv = process.env): string | null {
  if (item.packId) return env[`STRIPE_PRICE_${item.packId.toUpperCase()}`]?.trim() || null;
  if (item.planId) {
    const suffix = (item.period ?? "monthly") === "yearly" ? "ANNUAL" : "MONTHLY";
    // ANNUAL is the canonical repository-variable suffix; YEARLY kept so an
    // older deployment keeps working.
    return env[`STRIPE_PRICE_${item.planId.toUpperCase()}_${suffix}`]?.trim()
      ?? env[`STRIPE_PRICE_${item.planId.toUpperCase()}_YEARLY`]?.trim()
      ?? null;
  }
  return null;
}

/** Reverse lookup: which plan a Stripe price id stands for. */
export function planForPrice(priceId: string, env: NodeJS.ProcessEnv = process.env): PlanId | null {
  for (const plan of Object.keys(PLANS)) {
    for (const period of ["MONTHLY", "ANNUAL", "YEARLY"]) {
      if (env[`STRIPE_PRICE_${plan.toUpperCase()}_${period}`]?.trim() === priceId) return plan as PlanId;
    }
  }
  return null;
}

// ---------- signature ----------

/** Verifies a Stripe-Signature header (v1 HMAC-SHA256 over "t.body", 5-minute tolerance). */
export function verifyStripeSignature(rawBody: Buffer | string, header: string | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = Number(parts.find(([k]) => k === "t")?.[1]);
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!Number.isFinite(t) || !sigs.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`).digest();
  return sigs.some((s) => {
    try {
      const got = Buffer.from(s, "hex");
      return got.length === expected.length && timingSafeEqual(got, expected);
    } catch { return false; }
  });
}

/** Test helper: the header Stripe would send for this body. */
export function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

// ---------- REST ----------

function form(params: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => {
      if (item && typeof item === "object") out.push(...form(item as Record<string, unknown>, `${key}[${i}]`));
      else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
    });
    else if (typeof v === "object") out.push(...form(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export class StripeApiError extends Error {
  constructor(readonly status: number, message: string, readonly type?: string) { super(message); }
}

export async function stripeRequest<T = any>(cfg: StripeConfig, method: "GET" | "POST", pathName: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<T> {
  const body = form(params).join("&");
  const url = method === "GET" && body ? `${cfg.apiBase}${pathName}?${body}` : `${cfg.apiBase}${pathName}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? body : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json().catch(() => ({})) as any;
  if (!res.ok) throw new StripeApiError(res.status, String(data?.error?.message ?? `Stripe HTTP ${res.status}`), data?.error?.type);
  return data as T;
}

// ---------- store ----------

export class StripeStore {
  readonly db: DatabaseSync;
  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stripe_customers (account_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL UNIQUE, email TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS stripe_events (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at INTEGER NOT NULL,
        status TEXT NOT NULL, error TEXT, processed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS stripe_checkouts (
        session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL, item TEXT NOT NULL,
        period TEXT, status TEXT NOT NULL, payment_intent TEXT, subscription_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS stripe_checkouts_pi ON stripe_checkouts(payment_intent);
      CREATE TABLE IF NOT EXISTS stripe_subscriptions (
        subscription_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, plan_id TEXT NOT NULL, status TEXT NOT NULL,
        period_start INTEGER, period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
    `);
  }
  customerOf(accountId: string): string | null {
    return (this.db.prepare(`SELECT customer_id FROM stripe_customers WHERE account_id = ?`).get(accountId) as { customer_id: string } | undefined)?.customer_id ?? null;
  }
  accountOfCustomer(customerId: string): string | null {
    return (this.db.prepare(`SELECT account_id FROM stripe_customers WHERE customer_id = ?`).get(customerId) as { account_id: string } | undefined)?.account_id ?? null;
  }
  saveCustomer(accountId: string, customerId: string, email: string | null): void {
    this.db.prepare(`INSERT OR IGNORE INTO stripe_customers (account_id, customer_id, email, created_at) VALUES (?, ?, ?, ?)`).run(accountId, customerId, email, Date.now());
  }
  /** true when the event is new (recorded now); false for a replay already handled. */
  claimEvent(id: string, type: string): boolean {
    const prior = this.db.prepare(`SELECT status FROM stripe_events WHERE id = ?`).get(id) as { status: string } | undefined;
    if (prior && prior.status === "processed") return false;
    if (!prior) this.db.prepare(`INSERT INTO stripe_events (id, type, received_at, status) VALUES (?, ?, ?, 'received')`).run(id, type, Date.now());
    return true;
  }
  finishEvent(id: string, status: "processed" | "failed" | "ignored", error?: string): void {
    this.db.prepare(`UPDATE stripe_events SET status = ?, error = ?, processed_at = ? WHERE id = ?`).run(status, error ?? null, Date.now(), id);
  }
  eventStatus(id: string): string | null {
    return (this.db.prepare(`SELECT status FROM stripe_events WHERE id = ?`).get(id) as { status: string } | undefined)?.status ?? null;
  }
  saveCheckout(row: { sessionId: string; accountId: string; kind: "subscription" | "topup"; item: string; period?: string }): void {
    this.db.prepare(`INSERT OR IGNORE INTO stripe_checkouts (session_id, account_id, kind, item, period, status, created_at) VALUES (?, ?, ?, ?, ?, 'open', ?)`)
      .run(row.sessionId, row.accountId, row.kind, row.item, row.period ?? null, Date.now());
  }
  checkout(sessionId: string) {
    return this.db.prepare(`SELECT * FROM stripe_checkouts WHERE session_id = ?`).get(sessionId) as { session_id: string; account_id: string; kind: string; item: string; status: string; payment_intent: string | null } | undefined;
  }
  checkoutByPaymentIntent(pi: string) {
    return this.db.prepare(`SELECT * FROM stripe_checkouts WHERE payment_intent = ?`).get(pi) as { account_id: string; kind: string; item: string } | undefined;
  }
  completeCheckout(sessionId: string, fields: { paymentIntent?: string | null; subscriptionId?: string | null }): void {
    this.db.prepare(`UPDATE stripe_checkouts SET status = 'complete', payment_intent = COALESCE(?, payment_intent), subscription_id = COALESCE(?, subscription_id) WHERE session_id = ?`)
      .run(fields.paymentIntent ?? null, fields.subscriptionId ?? null, sessionId);
  }
  saveSubscription(s: { subscriptionId: string; accountId: string; planId: string; status: string; periodStart?: number; periodEnd?: number; cancelAtPeriodEnd?: boolean }): void {
    this.db.prepare(
      `INSERT INTO stripe_subscriptions (subscription_id, account_id, plan_id, status, period_start, period_end, cancel_at_period_end, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(subscription_id) DO UPDATE SET plan_id = excluded.plan_id, status = excluded.status,
         period_start = COALESCE(excluded.period_start, period_start), period_end = COALESCE(excluded.period_end, period_end),
         cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`,
    ).run(s.subscriptionId, s.accountId, s.planId, s.status, s.periodStart ?? null, s.periodEnd ?? null, s.cancelAtPeriodEnd ? 1 : 0, Date.now());
  }
  subscription(id: string) {
    return this.db.prepare(`SELECT * FROM stripe_subscriptions WHERE subscription_id = ?`).get(id) as { subscription_id: string; account_id: string; plan_id: string; status: string } | undefined;
  }
  recentEvents(limit = 50) {
    return this.db.prepare(`SELECT * FROM stripe_events ORDER BY received_at DESC LIMIT ?`).all(limit);
  }
}

let storeSingleton: StripeStore | null = null;
export function stripeStore(): StripeStore {
  if (!storeSingleton) storeSingleton = new StripeStore(path.join(defaultDataDir(), "payments.sqlite"));
  return storeSingleton;
}

// ---------- the payment service ----------

export interface Notify {
  paymentFailed?(accountId: string, info: { amountDue?: number; hostedInvoiceUrl?: string | null }): void;
  paymentSucceeded?(accountId: string, info: { description: string; amountUsd?: number }): void;
}

export class BillingService {
  constructor(
    private cfg: StripeConfig | null,
    private store: StripeStore,
    private ledger: CreditLedger,
    private notify: Notify = {},
    private env: NodeJS.ProcessEnv = process.env,
  ) {}

  get enabled(): boolean {
    return Boolean(this.cfg);
  }

  private require(): StripeConfig {
    if (!this.cfg) throw new StripeApiError(503, "Payments are not set up on this server yet.");
    return this.cfg;
  }

  private returnUrl(pathName: string, origin?: string): string {
    return `${(this.cfg?.publicOrigin || origin || "").replace(/\/$/, "")}${pathName}`;
  }

  async ensureCustomer(accountId: string, email: string, name?: string | null): Promise<string> {
    const cfg = this.require();
    const existing = this.store.customerOf(accountId);
    if (existing) return existing;
    const customer = await stripeRequest<{ id: string }>(cfg, "POST", "/v1/customers", {
      email, name: name ?? undefined, metadata: { accountId },
    }, `customer:${accountId}`);
    this.store.saveCustomer(accountId, customer.id, email);
    return customer.id;
  }

  /** A Checkout Session for a plan (subscription) or a credit pack (one-time). Returns the hosted URL. */
  async checkout(input: { accountId: string; email: string; name?: string | null; planId?: string; period?: Period; packId?: string; origin?: string; returnTo?: "portal" }): Promise<{ url: string; sessionId: string }> {
    const cfg = this.require();
    const isPack = Boolean(input.packId);
    if (isPack && !packById(input.packId!)) throw new StripeApiError(400, "Unknown credit pack.");
    if (!isPack) {
      const plan = planById(input.planId ?? "");
      if (plan.id !== input.planId || !plan.public || plan.priceMonthlyUsd === 0 || plan.priceMonthlyUsd === null) throw new StripeApiError(400, "That plan can't be bought online.");
    }
    const price = priceIdFor({ planId: input.planId, period: input.period, packId: input.packId }, this.env);
    if (!price) throw new StripeApiError(503, "That option isn't available for purchase yet.");
    const customer = await this.ensureCustomer(input.accountId, input.email, input.name);
    const metadata = isPack
      ? { accountId: input.accountId, kind: "topup", packId: input.packId! }
      : { accountId: input.accountId, kind: "subscription", planId: input.planId!, period: input.period ?? "monthly" };
    const session = await stripeRequest<{ id: string; url: string }>(cfg, "POST", "/v1/checkout/sessions", {
      mode: isPack ? "payment" : "subscription",
      customer,
      client_reference_id: input.accountId,
      line_items: [{ price, quantity: 1 }],
      // The Cloud portal returns to its Billing page (which says "confirming"
      // until the webhook lands); the desktop gets the standalone page.
      success_url: this.returnUrl(input.returnTo === "portal" ? "/billing?checkout=success" : "/api/v1/billing/return?status=success&session_id={CHECKOUT_SESSION_ID}", input.origin),
      cancel_url: this.returnUrl(input.returnTo === "portal" ? "/billing?checkout=cancel" : "/api/v1/billing/return?status=cancel", input.origin),
      metadata,
      ...(isPack
        ? { payment_intent_data: { metadata, setup_future_usage: "off_session" } }
        : { subscription_data: { metadata } }),
      allow_promotion_codes: "true",
    });
    this.store.saveCheckout({ sessionId: session.id, accountId: input.accountId, kind: isPack ? "topup" : "subscription", item: (isPack ? input.packId : input.planId)!, period: input.period });
    return { url: session.url, sessionId: session.id };
  }

  /** Stripe's hosted customer portal (payment methods, invoices, cancel). */
  async portal(accountId: string, origin?: string, returnTo?: "portal"): Promise<{ url: string }> {
    const cfg = this.require();
    const customer = this.store.customerOf(accountId);
    if (!customer) throw new StripeApiError(404, "There's no billing account yet — buy a plan or credits first.");
    const s = await stripeRequest<{ url: string }>(cfg, "POST", "/v1/billing_portal/sessions", { customer, return_url: this.returnUrl(returnTo === "portal" ? "/billing" : "/api/v1/billing/return?status=portal", origin) });
    return { url: s.url };
  }

  /**
   * What the Billing page shows from Stripe: recent invoices and the card on
   * file (brand, last 4, expiry — never more). Read-only; nothing here
   * changes paid state.
   */
  async account(accountId: string): Promise<{ invoices: { id: string; date: number; description: string; amountUsd: number; status: string; hostedUrl: string | null; pdfUrl: string | null }[]; paymentMethod: { brand: string; last4: string; expMonth: number; expYear: number } | null; subscription: { cancelAtPeriodEnd: boolean; currentPeriodEnd: number | null; status: string } | null }> {
    const cfg = this.cfg;
    const customer = this.store.customerOf(accountId);
    if (!cfg || !customer) return { invoices: [], paymentMethod: null, subscription: null };
    const [inv, pms, subs] = await Promise.all([
      stripeRequest<{ data: any[] }>(cfg, "GET", "/v1/invoices", { customer, limit: 12 }).catch(() => ({ data: [] })),
      stripeRequest<{ data: any[] }>(cfg, "GET", "/v1/payment_methods", { customer, type: "card", limit: 1 }).catch(() => ({ data: [] })),
      stripeRequest<{ data: any[] }>(cfg, "GET", "/v1/subscriptions", { customer, status: "all", limit: 1 }).catch(() => ({ data: [] })),
    ]);
    const card = pms.data?.[0]?.card;
    const sub = subs.data?.[0];
    return {
      invoices: (inv.data ?? []).map((i: any) => ({
        id: String(i.id),
        date: Number(i.created ?? 0) * 1000,
        description: String(i.lines?.data?.[0]?.description ?? i.description ?? "ORVYN"),
        amountUsd: Number(i.amount_paid ?? i.amount_due ?? 0) / 100,
        status: String(i.status ?? ""),
        hostedUrl: i.hosted_invoice_url ?? null,
        pdfUrl: i.invoice_pdf ?? null,
      })),
      paymentMethod: card ? { brand: String(card.brand ?? ""), last4: String(card.last4 ?? ""), expMonth: Number(card.exp_month ?? 0), expYear: Number(card.exp_year ?? 0) } : null,
      subscription: sub ? { cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end), currentPeriodEnd: sub.current_period_end ? Number(sub.current_period_end) * 1000 : (sub.items?.data?.[0]?.current_period_end ? Number(sub.items.data[0].current_period_end) * 1000 : null), status: String(sub.status ?? "") } : null,
    };
  }

  /** Auto-recharge: charge the saved card off-session. Credits arrive with the payment_intent.succeeded webhook. */
  async autoRecharge(accountId: string, packId: PackId): Promise<void> {
    const cfg = this.require();
    const customer = this.store.customerOf(accountId);
    const pack = packById(packId);
    if (!customer || !pack) { this.ledger.autoRechargeFailed(accountId); return; }
    try {
      const methods = await stripeRequest<{ data: { id: string }[] }>(cfg, "GET", "/v1/payment_methods", { customer, type: "card", limit: 1 });
      const pm = methods.data?.[0]?.id;
      if (!pm) { this.ledger.autoRechargeFailed(accountId); return; }
      const sub = this.ledger.subscriptionOf(accountId);
      await stripeRequest(cfg, "POST", "/v1/payment_intents", {
        amount: Math.round(pack.priceUsd * 100), currency: "usd", customer, payment_method: pm,
        off_session: "true", confirm: "true",
        metadata: { accountId, kind: "auto_recharge", packId },
        description: `ORVYN auto-recharge: ${pack.credits.toLocaleString("en-US")} credits`,
      }, `recharge:${accountId}:${sub?.cycleStart ?? 0}:${Date.now()}`);
    } catch (err) {
      this.ledger.autoRechargeFailed(accountId);
      console.warn(JSON.stringify({ event: "billing.auto_recharge_failed", accountId, reason: (err as Error).message.slice(0, 160) }));
    }
  }

  // ---------- webhook ----------

  /**
   * Verifies and applies one webhook delivery. Returns the HTTP status to
   * answer with: 400 for a bad signature, 200 for handled or replayed
   * events, 500 when processing failed (Stripe retries it later).
   */
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ status: number; body: Record<string, unknown> }> {
    const cfg = this.require();
    if (!cfg.webhookSecret || !verifyStripeSignature(rawBody, signature, cfg.webhookSecret)) {
      return { status: 400, body: { error: "Invalid signature" } };
    }
    let event: { id: string; type: string; data: { object: any } };
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "Invalid payload" } };
    }
    if (!event?.id || !event?.type) return { status: 400, body: { error: "Invalid event" } };
    if (!this.store.claimEvent(event.id, event.type)) return { status: 200, body: { received: true, duplicate: true } };
    try {
      const handled = await this.apply(event);
      this.store.finishEvent(event.id, handled ? "processed" : "ignored");
      return { status: 200, body: { received: true } };
    } catch (err) {
      this.store.finishEvent(event.id, "failed", (err as Error).message.slice(0, 300));
      console.error(JSON.stringify({ event: "billing.webhook_failed", type: event.type, id: event.id, reason: (err as Error).message.slice(0, 200) }));
      return { status: 500, body: { error: "Processing failed; Stripe will retry." } };
    }
  }

  private accountFor(obj: any): string | null {
    const fromMeta = obj?.metadata?.accountId || obj?.subscription_details?.metadata?.accountId || obj?.parent?.subscription_details?.metadata?.accountId;
    if (fromMeta) return String(fromMeta);
    const customer = typeof obj?.customer === "string" ? obj.customer : obj?.customer?.id;
    return customer ? this.store.accountOfCustomer(customer) : null;
  }

  private async apply(event: { id: string; type: string; data: { object: any } }): Promise<boolean> {
    const o = event.data.object;
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const accountId = this.accountFor(o);
        if (!accountId) return false;
        if (o.customer) this.store.saveCustomer(accountId, String(o.customer), o.customer_details?.email ?? null);
        const kind = o.mode === "payment" ? "topup" : "subscription";
        this.store.saveCheckout({ sessionId: o.id, accountId, kind, item: String((kind === "topup" ? o.metadata?.packId : o.metadata?.planId) ?? ""), period: o.metadata?.period });
        this.store.completeCheckout(o.id, { paymentIntent: o.payment_intent ?? null, subscriptionId: o.subscription ?? null });
        if (o.mode === "payment" && o.metadata?.kind === "topup") {
          if (o.payment_status !== "paid") return true; // async methods finish in async_payment_succeeded
          const packId = String(o.metadata.packId) as PackId;
          this.ledger.creditPurchase(accountId, packId, { paymentRef: String(o.payment_intent ?? o.id), source: "checkout", amountUsd: (o.amount_total ?? 0) / 100 });
          const pack = packById(packId);
          this.notify.paymentSucceeded?.(accountId, { description: `${pack?.credits.toLocaleString("en-US")} ORVYN credits`, amountUsd: (o.amount_total ?? 0) / 100 });
        }
        // Subscriptions: credits come with invoice.paid.
        return true;
      }
      case "invoice.paid":
      case "invoice.payment_succeeded": {
        const subscriptionId = String(o.subscription ?? o.parent?.subscription_details?.subscription ?? "");
        if (!subscriptionId) return false;
        const line = (o.lines?.data ?? []).find((l: any) => l?.price?.id || l?.pricing?.price_details?.price) ?? o.lines?.data?.[0];
        const priceId = String(line?.price?.id ?? line?.pricing?.price_details?.price ?? "");
        const known = this.store.subscription(subscriptionId);
        const planId = planForPrice(priceId, this.env) ?? (o.subscription_details?.metadata?.planId as PlanId | undefined) ?? (o.parent?.subscription_details?.metadata?.planId as PlanId | undefined) ?? (known?.plan_id as PlanId | undefined);
        const accountId = this.accountFor(o) ?? known?.account_id ?? null;
        if (!accountId || !planId) throw new Error(`invoice ${o.id}: cannot map to an account/plan`);
        const periodStart = Number(line?.period?.start ?? o.period_start) * 1000;
        const periodEnd = Number(line?.period?.end ?? o.period_end) * 1000;
        this.store.saveSubscription({ subscriptionId, accountId, planId, status: "active", periodStart, periodEnd });
        this.ledger.applySubscription({ accountId, planId, subscriptionId, periodStart, periodEnd, status: "active" });
        this.notify.paymentSucceeded?.(accountId, { description: `ORVYN ${planById(planId).label}`, amountUsd: (o.amount_paid ?? 0) / 100 });
        return true;
      }
      case "invoice.payment_failed": {
        const accountId = this.accountFor(o);
        if (!accountId) return false;
        this.ledger.setSubscriptionStatus(accountId, "past_due");
        this.notify.paymentFailed?.(accountId, { amountDue: (o.amount_due ?? 0) / 100, hostedInvoiceUrl: o.hosted_invoice_url ?? null });
        return true;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const accountId = this.accountFor(o);
        if (!accountId) return false;
        const priceId = String(o.items?.data?.[0]?.price?.id ?? "");
        const planId = planForPrice(priceId, this.env) ?? (o.metadata?.planId as PlanId | undefined);
        if (!planId) return false;
        this.store.saveSubscription({ subscriptionId: o.id, accountId, planId, status: String(o.status), cancelAtPeriodEnd: Boolean(o.cancel_at_period_end) });
        // Status only: credits are granted by paid invoices, never here.
        this.ledger.setSubscriptionStatus(accountId, String(o.status));
        return true;
      }
      case "customer.subscription.deleted": {
        const accountId = this.accountFor(o);
        if (!accountId) return false;
        this.store.saveSubscription({ subscriptionId: o.id, accountId, planId: String(o.metadata?.planId ?? "free"), status: "canceled" });
        this.ledger.endSubscription(accountId, o.id);
        return true;
      }
      case "payment_intent.succeeded": {
        if (o.metadata?.kind !== "auto_recharge") return false; // checkout top-ups are credited from the session
        const accountId = this.accountFor(o);
        if (!accountId) return false;
        this.ledger.creditPurchase(accountId, String(o.metadata.packId) as PackId, { paymentRef: String(o.id), source: "auto_recharge", amountUsd: (o.amount_received ?? o.amount ?? 0) / 100 });
        return true;
      }
      case "payment_intent.payment_failed": {
        if (o.metadata?.kind !== "auto_recharge") return false;
        const accountId = this.accountFor(o);
        if (accountId) this.ledger.autoRechargeFailed(accountId);
        return true;
      }
      case "charge.refunded": {
        const pi = String(o.payment_intent ?? "");
        const checkout = pi ? this.store.checkoutByPaymentIntent(pi) : undefined;
        const accountId = checkout?.account_id ?? this.accountFor(o);
        const packId = (checkout?.kind === "topup" ? checkout.item : o.metadata?.packId) as string | undefined;
        const pack = packId ? packById(packId) : null;
        if (!accountId || !pack) return false;
        const fraction = o.amount ? Math.min(1, (o.amount_refunded ?? 0) / o.amount) : 1;
        this.ledger.refund(accountId, Math.round(pack.credits * fraction), { paymentRef: `${pi || o.id}:${o.amount_refunded ?? 0}`, reason: "stripe_refund" });
        return true;
      }
      default:
        return false;
    }
  }
}

let serviceSingleton: BillingService | null = null;
export function billingService(): BillingService {
  if (!serviceSingleton) {
    serviceSingleton = new BillingService(stripeConfig(), stripeStore(), defaultLedger);
    // Auto-recharge asks Stripe for the payment; the webhook adds the credits.
    defaultLedger.onAutoRecharge((accountId, packId) => { void serviceSingleton?.autoRecharge(accountId, packId); });
  }
  return serviceSingleton;
}

/** For admin/billing views: every pack with whether it can be bought here. */
export function purchasablePacks(env: NodeJS.ProcessEnv = process.env) {
  return CREDIT_PACKS.map((p) => ({ ...p, available: Boolean(priceIdFor({ packId: p.id }, env)) }));
}

export function setBillingNotify(n: Notify): void {
  const svc = billingService() as unknown as { notify: Notify };
  svc.notify = n;
}
