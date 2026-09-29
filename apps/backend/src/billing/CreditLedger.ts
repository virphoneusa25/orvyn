import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { customerCreditsFor, providerCostUsd } from "./creditMath";
import { CREDIT_PACKS, DEFAULT_PLAN, LANE_FACTORS, type Lane, type PackId, type PlanId, packById, planById } from "./plans";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CYCLE = 30 * DAY;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function streakEnding(days: string[], now: number): number {
  const set = new Set(days);
  let cursor = dayKey(now);
  if (!set.has(cursor)) cursor = dayKey(now - 86_400_000);
  let n = 0;
  while (set.has(cursor)) {
    n++;
    cursor = dayKey(Date.parse(cursor + "T00:00:00Z") - 86_400_000);
  }
  return n;
}

interface Part { credits: number; tokens: number }
interface DayBucket {
  tokens: number;
  credits: number;
  cached: number;
  input: number;
  models: Record<string, Part>;
  tools: Record<string, Part>;
}

function emptyDay(): DayBucket {
  return { tokens: 0, credits: 0, cached: 0, input: 0, models: {}, tools: {} };
}

function addPart(bucket: Record<string, Part>, key: string, credits: number, tokens: number): void {
  const part = bucket[key] ?? { credits: 0, tokens: 0 };
  part.credits += credits;
  part.tokens += tokens;
  bucket[key] = part;
}

/** Maps a billed lane onto the App usage task list. Unknown work stays in Other. */
function taskFor(type: string, lane: string): string {
  if (type === "image" || lane === "image" || lane === "image_pro") return "Content creation";
  if (type === "search" || lane === "search" || lane === "deep") return "Research & analysis";
  if (lane === "build" || lane === "server" || lane === "advanced") return "Coding & development";
  if (type === "compute" || lane === "compute") return "Data analysis";
  if (type === "model" || lane === "auto" || lane === "utility") return "General chat";
  return "Other";
}

function longestStreak(days: string[]): number {
  let best = 0;
  let run = 0;
  let prev = "";
  for (const day of days) {
    const expected = prev ? dayKey(Date.parse(prev + "T00:00:00Z") + 86_400_000) : day;
    run = day === expected ? run + 1 : 1;
    best = Math.max(best, run);
    prev = day;
  }
  return best;
}

export class BillingLimitError extends Error {
  readonly code: string;
  /** Marks a wallet/plan stop (never a provider failure to fail over from). */
  readonly billing = true;
  readonly statusCode = 402;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BillingLimitError";
    this.code = code;
  }
}

interface RateCard {
  id: string;
  provider: string;
  modelId: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  effectiveFrom: number;
  effectiveTo: number | null;
}

export interface UsageChargeInput {
  userId: string;
  organizationId?: string;
  sessionId?: string;
  runId?: string;
  type: "model" | "search" | "compute" | "image" | "storage";
  provider?: string;
  model?: string;
  lane?: Lane;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** When set, this is the provider cost. Otherwise the active rate card prices the tokens. */
  providerCostUsd?: number;
  ok?: boolean;
  now?: number;
}

/**
 * Ledger entry types. A balance is never stored: it is the sum of immutable
 * entries. Every entry carries a unique idempotency key, so a replayed
 * webhook, a retried call or a failover can never grant or charge twice.
 */
export type EntryType =
  | "monthly_grant"
  | "topup_purchase"
  | "mission_reservation"
  | "usage_settlement"
  | "reservation_release"
  | "refund"
  | "admin_adjustment"
  | "expiration";

/** included: this cycle's plan credits. purchased: top-ups (carry over). hold: credits reserved for running missions. */
export type Bucket = "included" | "purchased" | "hold";

export interface LedgerEntry {
  id: string;
  accountId: string;
  type: EntryType;
  bucket: Bucket;
  amount: number;
  idempotencyKey: string;
  runId: string | null;
  actor: string | null;
  meta: Record<string, unknown>;
  createdAt: number;
}

export interface SubscriptionState {
  accountId: string;
  planId: PlanId;
  subscriptionId: string;
  periodStart: number;
  periodEnd: number;
  status: string;
}

export class CreditLedger {
  private db: DatabaseSync;
  private rechargeListeners = new Set<(accountId: string, packId: PackId) => void>();

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        account_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        subscription_id TEXT,
        subscription_status TEXT NOT NULL DEFAULT 'none',
        cycle_start INTEGER NOT NULL,
        cycle_end INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ledger_entries (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,
        type TEXT NOT NULL,
        bucket TEXT NOT NULL CHECK (bucket IN ('included','purchased','hold')),
        amount INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        run_id TEXT,
        actor TEXT,
        meta TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ledger_account ON ledger_entries(account_id, created_at);
      CREATE INDEX IF NOT EXISTS ledger_run ON ledger_entries(run_id);
      CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger_entries
        BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger_entries
        BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        organization_id TEXT,
        session_id TEXT,
        run_id TEXT,
        type TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        lane TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        provider_cost_micros INTEGER NOT NULL,
        credits_charged INTEGER NOT NULL,
        rate_card_id TEXT,
        ok INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_cards (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        input_usd_per_million REAL NOT NULL,
        cached_input_usd_per_million REAL NOT NULL,
        output_usd_per_million REAL NOT NULL,
        effective_from INTEGER NOT NULL,
        effective_to INTEGER
      );
      CREATE TABLE IF NOT EXISTS auto_recharge (
        user_id TEXT PRIMARY KEY,
        threshold INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        max_per_month INTEGER NOT NULL,
        recharges_this_cycle INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS auto_recharge_requests (
        account_id TEXT NOT NULL,
        cycle_start INTEGER NOT NULL,
        n INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, cycle_start, n)
      );
      CREATE TABLE IF NOT EXISTS run_budget (
        run_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        extra_usd REAL NOT NULL DEFAULT 0
      );
    `);
    this.seedDefaultRateCard();
    this.migrateV1();
  }

  close(): void {
    this.db.close();
  }

  // ---------- rate cards (versioned: a new card closes the old one, never rewrites it) ----------

  seedDefaultRateCard(now = Date.now()): void {
    const existing = this.db.prepare(`SELECT id FROM rate_cards WHERE model_id = 'default' AND effective_to IS NULL`).get();
    if (existing) return;
    this.db.prepare(
      `INSERT INTO rate_cards (id, provider, model_id, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, effective_from, effective_to)
       VALUES (?, 'orvyn', 'default', 0.2, 0.02, 0.8, ?, NULL)`,
    ).run(`rc_${randomUUID().slice(0, 8)}`, now);
  }

  setRateCard(card: Omit<RateCard, "id" | "effectiveTo"> & { effectiveFrom?: number }): RateCard {
    const from = card.effectiveFrom ?? Date.now();
    this.db.prepare(
      `UPDATE rate_cards SET effective_to = ? WHERE model_id = ? AND provider = ? AND effective_to IS NULL AND effective_from < ?`,
    ).run(from, card.modelId, card.provider, from);
    const id = `rc_${randomUUID().slice(0, 8)}`;
    this.db.prepare(
      `INSERT INTO rate_cards (id, provider, model_id, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, effective_from, effective_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(id, card.provider, card.modelId, card.inputUsdPerMillion, card.cachedInputUsdPerMillion, card.outputUsdPerMillion, from);
    return { ...card, id, effectiveFrom: from, effectiveTo: null };
  }

  rateCardAt(provider: string, modelId: string, at: number): RateCard | null {
    const row = this.db.prepare(
      `SELECT * FROM rate_cards WHERE model_id = ? AND provider = ? AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY effective_from DESC LIMIT 1`,
    ).get(modelId, provider, at, at) as any;
    const fallback = row ?? this.db.prepare(
      `SELECT * FROM rate_cards WHERE model_id = 'default' AND effective_from <= ? AND (effective_to IS NULL OR effective_to > ?)
       ORDER BY effective_from DESC LIMIT 1`,
    ).get(at, at) as any;
    if (!fallback) return null;
    return {
      id: fallback.id,
      provider: fallback.provider,
      modelId: fallback.model_id,
      inputUsdPerMillion: fallback.input_usd_per_million,
      cachedInputUsdPerMillion: fallback.cached_input_usd_per_million,
      outputUsdPerMillion: fallback.output_usd_per_million,
      effectiveFrom: fallback.effective_from,
      effectiveTo: fallback.effective_to,
    };
  }

  listRateCards(): RateCard[] {
    return (this.db.prepare(`SELECT * FROM rate_cards ORDER BY provider, model_id, effective_from`).all() as any[]).map((r) => ({
      id: r.id, provider: r.provider, modelId: r.model_id, inputUsdPerMillion: r.input_usd_per_million,
      cachedInputUsdPerMillion: r.cached_input_usd_per_million, outputUsdPerMillion: r.output_usd_per_million,
      effectiveFrom: r.effective_from, effectiveTo: r.effective_to,
    }));
  }

  // ---------- wallets and plan cycles ----------

  /** Creates the wallet with its first plan grant (once), and rolls a Free cycle that has ended. */
  ensureAccount(accountId: string, planId: PlanId = DEFAULT_PLAN, now = Date.now()): void {
    this.tx(() => {
      if (!this.wallet(accountId)) {
        const plan = planById(planId);
        this.db.prepare(
          `INSERT INTO wallets (account_id, plan_id, subscription_status, cycle_start, cycle_end, created_at) VALUES (?, ?, 'none', ?, ?, ?)`,
        ).run(accountId, plan.id, now, now + CYCLE, now);
        this.grant(accountId, plan.id, `grant:${accountId}:signup`, now, { plan: plan.id, reason: "signup" });
        return;
      }
      this.rollCycle(accountId, now);
    });
  }

  /**
   * The only way a paid plan starts or renews: a verified subscription event
   * (Stripe webhook) or a staff action. One grant per subscription period,
   * however many times the event is delivered.
   */
  applySubscription(s: SubscriptionState, now = Date.now()): { granted: boolean } {
    let granted = false;
    this.tx(() => {
      if (!this.wallet(s.accountId)) {
        this.db.prepare(
          `INSERT INTO wallets (account_id, plan_id, subscription_status, cycle_start, cycle_end, created_at) VALUES (?, ?, 'none', ?, ?, ?)`,
        ).run(s.accountId, DEFAULT_PLAN, now, now + CYCLE, now);
      }
      const plan = planById(s.planId);
      this.db.prepare(
        `UPDATE wallets SET plan_id = ?, subscription_id = ?, subscription_status = ?, cycle_start = ?, cycle_end = ? WHERE account_id = ?`,
      ).run(plan.id, s.subscriptionId, s.status, s.periodStart, s.periodEnd, s.accountId);
      if (s.status === "active" || s.status === "trialing") {
        granted = this.grant(s.accountId, plan.id, `grant:${s.subscriptionId}:${s.periodStart}:${plan.id}`, now, {
          plan: plan.id, subscriptionId: s.subscriptionId, periodStart: s.periodStart, periodEnd: s.periodEnd,
        });
      }
    });
    return { granted };
  }

  /** Subscription ended: the account returns to Free from the end of the paid period. */
  endSubscription(accountId: string, subscriptionId: string, now = Date.now()): void {
    this.tx(() => {
      const w = this.wallet(accountId);
      if (!w || (w.subscription_id && w.subscription_id !== subscriptionId)) return;
      const start = Math.max(now, 0);
      this.db.prepare(
        `UPDATE wallets SET plan_id = ?, subscription_status = 'canceled', cycle_start = ?, cycle_end = ? WHERE account_id = ?`,
      ).run(DEFAULT_PLAN, start, start + CYCLE, accountId);
      this.grant(accountId, DEFAULT_PLAN, `grant:${accountId}:free:${subscriptionId}:end`, now, { plan: DEFAULT_PLAN, reason: "subscription_ended" });
    });
  }

  /** Marks the subscription's payment state (past_due, unpaid…) without granting anything. */
  setSubscriptionStatus(accountId: string, status: string): void {
    this.db.prepare(`UPDATE wallets SET subscription_status = ? WHERE account_id = ?`).run(status, accountId);
  }

  /**
   * Test/dev helper and staff tool: put a wallet on a plan with a fresh grant.
   * Never reachable from a customer route — customers change plans through checkout.
   */
  setPlan(accountId: string, planId: PlanId, now = Date.now(), actor = "system"): void {
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    this.applySubscription({ accountId, planId, subscriptionId: `manual:${actor}:${now}`, periodStart: now, periodEnd: now + CYCLE, status: "active" }, now);
  }

  // ---------- money in ----------

  /** Credits a paid top-up. `paymentRef` is the payment's id (Stripe event / payment intent): one credit per payment. */
  creditPurchase(accountId: string, packId: PackId, opts: { paymentRef: string; source?: "checkout" | "auto_recharge"; amountUsd?: number }, now = Date.now()): { credits: number; priceUsd: number; duplicate: boolean } {
    const pack = packById(packId);
    if (!pack) throw new BillingLimitError("PACK", "Unknown credit pack.");
    if (!opts.paymentRef) throw new BillingLimitError("PAYMENT", "A top-up needs a payment reference.");
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    let duplicate = false;
    this.tx(() => {
      duplicate = !this.append({
        accountId, type: "topup_purchase", bucket: "purchased", amount: pack.credits,
        key: `topup:${opts.paymentRef}`, meta: { pack: pack.id, priceUsd: opts.amountUsd ?? pack.priceUsd, source: opts.source ?? "checkout", paymentRef: opts.paymentRef }, now,
      });
      if (!duplicate && opts.source === "auto_recharge") {
        this.db.prepare(`UPDATE auto_recharge_requests SET status = 'paid' WHERE account_id = ? AND status = 'pending'`).run(accountId);
      }
    });
    return { credits: pack.credits, priceUsd: pack.priceUsd, duplicate };
  }

  /** Back-compat for tests and staff tools: a top-up with an explicit reference. */
  purchase(accountId: string, packId: PackId, source: "checkout" | "auto_recharge" = "checkout", now = Date.now(), paymentRef = `manual:${randomUUID()}`): { credits: number; priceUsd: number } {
    const r = this.creditPurchase(accountId, packId, { paymentRef, source }, now);
    return { credits: r.credits, priceUsd: r.priceUsd };
  }

  /** A refunded payment removes what it bought (never below zero purchased credits). */
  refund(accountId: string, credits: number, opts: { paymentRef: string; reason?: string }, now = Date.now()): { refunded: number } {
    let refunded = 0;
    this.tx(() => {
      const purchased = this.bucketSum(accountId, "purchased");
      refunded = Math.max(0, Math.min(credits, purchased));
      if (refunded > 0) this.append({ accountId, type: "refund", bucket: "purchased", amount: -refunded, key: `refund:${opts.paymentRef}`, meta: { reason: opts.reason ?? "" }, now });
    });
    return { refunded };
  }

  /** Staff credit or debit. Always attributed, always with a reason; never an edit of history. */
  adminAdjust(accountId: string, credits: number, opts: { actor: string; reason: string; bucket?: "included" | "purchased"; key?: string }, now = Date.now()): LedgerEntry {
    if (!opts.actor?.trim()) throw new BillingLimitError("ADJUST", "An adjustment needs the staff member who made it.");
    if (!opts.reason?.trim()) throw new BillingLimitError("ADJUST", "An adjustment needs a reason.");
    if (!Number.isInteger(credits) || credits === 0) throw new BillingLimitError("ADJUST", "Adjust by a whole, non-zero number of credits.");
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    const key = opts.key ?? `adjust:${randomUUID()}`;
    this.tx(() => {
      this.append({ accountId, type: "admin_adjustment", bucket: opts.bucket ?? "purchased", amount: credits, key, actor: opts.actor, meta: { reason: opts.reason }, now });
    });
    return this.entryByKey(key)!;
  }

  // ---------- auto-recharge (asks for a payment; credits arrive only when it is paid) ----------

  setAutoRecharge(accountId: string, input: { threshold: number; packId: PackId; maxPerMonth: number }, now = Date.now()): void {
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    if (!packById(input.packId)) throw new BillingLimitError("PACK", "Unknown credit pack.");
    if (!(input.maxPerMonth >= 1) || input.maxPerMonth > 20) throw new BillingLimitError("RECHARGE", "Set a monthly maximum between 1 and 20.");
    if (!(input.threshold >= 0)) throw new BillingLimitError("RECHARGE", "Set a threshold of 0 or more credits.");
    this.db.prepare(
      `INSERT INTO auto_recharge (user_id, threshold, pack_id, max_per_month, recharges_this_cycle)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET threshold = excluded.threshold, pack_id = excluded.pack_id, max_per_month = excluded.max_per_month`,
    ).run(accountId, Math.floor(input.threshold), input.packId, Math.floor(input.maxPerMonth));
  }

  disableAutoRecharge(accountId: string): void {
    this.db.prepare(`DELETE FROM auto_recharge WHERE user_id = ?`).run(accountId);
  }

  /** The payment side (Stripe) listens here and charges the saved card off-session. */
  onAutoRecharge(listener: (accountId: string, packId: PackId) => void): () => void {
    this.rechargeListeners.add(listener);
    return () => this.rechargeListeners.delete(listener);
  }

  // ---------- runs: reserve → execute → settle → release ----------

  /** Holds credits for a mission. Idempotent per run; refuses when the wallet cannot cover it. */
  reserve(accountId: string, runId: string, credits: number, now = Date.now()): string {
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    const key = `reserve:${runId}`;
    this.tx(() => {
      if (this.entryByKey(key)) return;
      const w = this.wallet(accountId)!;
      const plan = planById(w.plan_id);
      const held = this.heldCount(accountId);
      if (held >= plan.concurrentRuns) {
        throw new BillingLimitError("CONCURRENCY", `${plan.label} allows ${plan.concurrentRuns} agent run${plan.concurrentRuns === 1 ? "" : "s"} at a time.`);
      }
      const available = this.available(accountId);
      if (credits > available) {
        throw new BillingLimitError("BALANCE", `This run needs ${credits} credits and ${available} are available.`);
      }
      this.append({ accountId, type: "mission_reservation", bucket: "hold", amount: credits, key, runId, meta: {}, now });
    });
    return this.entryByKey(key)!.id;
  }

  /** Returns what a finished run did not use. Safe to call more than once. */
  release(runId: string, now = Date.now()): void {
    this.tx(() => {
      const rsv = this.entryByKey(`reserve:${runId}`);
      if (!rsv) return;
      const remaining = this.holdRemaining(runId);
      if (remaining <= 0) return;
      this.append({ accountId: rsv.accountId, type: "reservation_release", bucket: "hold", amount: -remaining, key: `release:${runId}`, runId, meta: {}, now });
    });
  }

  /** Called before every model call: stop a run the wallet or the plan's windows can no longer pay for. */
  assertCanSpend(accountId: string, runId?: string, now = Date.now(), use: { lane?: Lane; type?: string } = {}): void {
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    if (use.lane || use.type) this.assertEntitlement(accountId, use.lane ?? "auto", use.type ?? "model", now);
    if (runId) this.assertRunCap(accountId, runId, 0, now);
    const available = this.available(accountId) + (runId ? this.holdRemaining(runId) : 0);
    if (available <= 0) {
      throw new BillingLimitError("BALANCE", "You're out of credits. Add credits or upgrade your plan to continue.");
    }
    const w = this.wallet(accountId)!;
    if (w.subscription_status === "unpaid" || w.subscription_status === "suspended") {
      throw new BillingLimitError("ACCOUNT", "Your account has a payment problem. Update your payment method to continue.");
    }
    const plan = planById(w.plan_id);
    const limit5h = this.bucketSum(accountId, "purchased") > 0 ? plan.burst5h : plan.rolling5h;
    const used5h = this.windowCredits(accountId, now - 5 * HOUR, now);
    if (used5h >= limit5h) {
      throw new BillingLimitError("WINDOW_5H", `You've used this 5-hour window's ${limit5h.toLocaleString("en-US")} credits. It frees up as earlier usage ages out.`);
    }
    const used7d = this.windowCredits(accountId, now - 7 * DAY, now);
    if (used7d >= plan.rolling7d) {
      throw new BillingLimitError("WINDOW_7D", `You've used this week's ${plan.rolling7d.toLocaleString("en-US")} credits. It frees up as earlier usage ages out.`);
    }
  }

  /**
   * Settles one metered event. `eventId` is the call's usage id: settling the
   * same event again (a retry, a replay, a failover that re-reports) charges
   * nothing. Failed work (ok: false) is recorded and not billed.
   */
  charge(input: UsageChargeInput & { eventId?: string }): { creditsCharged: number; providerCostUsd: number; eventId: string } {
    const now = input.now ?? Date.now();
    this.ensureAccount(input.userId, DEFAULT_PLAN, now);
    const eventId = input.eventId ?? `use_${randomUUID()}`;
    const prior = this.db.prepare(`SELECT credits_charged, provider_cost_micros FROM usage_events WHERE id = ?`).get(eventId) as { credits_charged: number; provider_cost_micros: number } | undefined;
    if (prior) return { creditsCharged: 0, providerCostUsd: prior.provider_cost_micros / 1_000_000, eventId };
    const lane: Lane = input.lane ?? "auto";
    const card = this.rateCardAt(input.provider ?? "orvyn", input.model ?? "default", now);
    const cost = input.providerCostUsd ?? (card
      ? providerCostUsd({
          inputTokens: input.inputTokens,
          cachedInputTokens: input.cachedInputTokens,
          outputTokens: input.outputTokens,
          inputUsdPerMillion: card.inputUsdPerMillion,
          cachedInputUsdPerMillion: card.cachedInputUsdPerMillion,
          outputUsdPerMillion: card.outputUsdPerMillion,
        })
      : 0);
    const quoted = customerCreditsFor(cost, LANE_FACTORS[lane] ?? LANE_FACTORS.auto);
    const billable = input.ok === false ? 0 : quoted.customerCredits;
    // Settlement never refuses: the work already happened. Limits are enforced
    // before each call (assertCanSpend); a shortfall is recorded, not forgiven.
    let charged = 0;
    this.tx(() => {
      if (billable > 0) charged = this.settle(input.userId, billable, eventId, input.runId ?? null, { lane, type: input.type }, now);
      this.db.prepare(
        `INSERT INTO usage_events (id, user_id, organization_id, session_id, run_id, type, provider, model, lane, input_tokens, cached_input_tokens, output_tokens, provider_cost_micros, credits_charged, rate_card_id, ok, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        eventId, input.userId, input.organizationId ?? null, input.sessionId ?? null, input.runId ?? null, input.type,
        input.provider ?? null, input.model ?? null, lane,
        input.inputTokens ?? null, input.cachedInputTokens ?? null, input.outputTokens ?? null,
        Math.round(cost * 1_000_000), charged, card?.id ?? null, input.ok === false ? 0 : 1, now,
      );
    });
    if (charged > 0) this.maybeAutoRecharge(input.userId, now);
    return { creditsCharged: charged, providerCostUsd: cost, eventId };
  }

  authorizeRun(userId: string, runId: string): void {
    const w = this.wallet(userId);
    const plan = planById(w?.plan_id ?? DEFAULT_PLAN);
    this.db.prepare(
      `INSERT INTO run_budget (run_id, user_id, extra_usd) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET extra_usd = extra_usd + ?`,
    ).run(runId, userId, plan.perRunCostUsd, plan.perRunCostUsd);
  }

  // ---------- reads ----------

  planOf(accountId: string): string | null {
    return this.wallet(accountId)?.plan_id ?? null;
  }

  subscriptionOf(accountId: string): { planId: string; subscriptionId: string | null; status: string; cycleStart: number; cycleEnd: number } | null {
    const w = this.wallet(accountId);
    return w ? { planId: w.plan_id, subscriptionId: w.subscription_id, status: w.subscription_status, cycleStart: w.cycle_start, cycleEnd: w.cycle_end } : null;
  }

  grantsIssued(accountId: string): { credits: number; plan: string; at: number }[] {
    const rows = this.db.prepare(`SELECT amount, meta, created_at FROM ledger_entries WHERE account_id = ? AND type = 'monthly_grant' ORDER BY seq`).all(accountId) as { amount: number; meta: string; created_at: number }[];
    return rows.map((r) => ({ credits: Number(r.amount), plan: String((JSON.parse(r.meta || "{}") as { plan?: string }).plan ?? ""), at: Number(r.created_at) }));
  }

  entries(accountId: string, limit = 100): LedgerEntry[] {
    return (this.db.prepare(`SELECT * FROM ledger_entries WHERE account_id = ? ORDER BY seq DESC LIMIT ?`).all(accountId, limit) as any[]).map(rowToEntry);
  }

  /** Every account's wallet (for staff views). */
  accounts(): { accountId: string; planId: string; status: string; available: number }[] {
    return (this.db.prepare(`SELECT account_id, plan_id, subscription_status FROM wallets ORDER BY created_at DESC`).all() as any[]).map((w) => ({
      accountId: w.account_id, planId: w.plan_id, status: w.subscription_status, available: this.available(w.account_id),
    }));
  }

  /** Invariant check: every balance is the sum of its entries and no bucket went negative. */
  verify(accountId: string): { ok: boolean; included: number; purchased: number; hold: number } {
    const included = this.bucketSum(accountId, "included");
    const purchased = this.bucketSum(accountId, "purchased");
    const hold = this.bucketSum(accountId, "hold");
    return { ok: included >= 0 && purchased >= 0 && hold >= 0, included, purchased, hold };
  }

  snapshot(accountId: string, now = Date.now()) {
    this.ensureAccount(accountId, DEFAULT_PLAN, now);
    const w = this.wallet(accountId)!;
    const plan = planById(w.plan_id);
    const included = this.bucketSum(accountId, "included");
    const purchased = this.bucketSum(accountId, "purchased");
    const hold = this.bucketSum(accountId, "hold");
    const used5h = this.windowCredits(accountId, now - 5 * HOUR, now);
    const used7d = this.windowCredits(accountId, now - 7 * DAY, now);
    const cycleUsed = this.windowCredits(accountId, w.cycle_start - 1, now);
    const limit5h = purchased > 0 ? plan.burst5h : plan.rolling5h;
    return {
      plan: { id: plan.id, label: plan.label, priceLabel: plan.priceLabel },
      subscription: { status: w.subscription_status, cycleStart: w.cycle_start, cycleEnd: w.cycle_end },
      includedBalance: included,
      purchasedBalance: purchased,
      reservedBalance: hold,
      availableBalance: included + purchased - hold,
      windows: {
        fiveHour: { used: used5h, limit: limit5h, resetAt: this.windowResetAt(accountId, now, 5 * HOUR) },
        sevenDay: { used: used7d, limit: plan.rolling7d, resetAt: this.windowResetAt(accountId, now, 7 * DAY) },
        cycle: { used: cycleUsed, limit: plan.monthlyCredits, resetAt: w.cycle_end },
      },
      packs: CREDIT_PACKS,
      autoRecharge: this.autoRechargeView(accountId),
      recent: this.recent(accountId, 12),
      note: "",
    };
  }

  /** Aggregates the usage page: windows, activity, heatmap, and credit series. */
  usageStats(userId: string, now = Date.now()) {
    const wallet = this.snapshot(userId, now);
    const rows = this.db.prepare(
      `SELECT created_at AS at, COALESCE(input_tokens, 0) AS inputTokens, COALESCE(cached_input_tokens, 0) AS cachedTokens,
              COALESCE(output_tokens, 0) AS outputTokens, credits_charged AS credits,
              COALESCE(model, 'ORVYN') AS model, COALESCE(type, 'model') AS type, COALESCE(lane, 'auto') AS lane,
              COALESCE(provider, 'Other') AS provider, session_id AS sessionId, run_id AS runId
       FROM usage_events WHERE user_id = ? AND ok = 1 ORDER BY created_at ASC`,
    ).all(userId) as {
      at: number; inputTokens: number; cachedTokens: number; outputTokens: number; credits: number;
      model: string; type: string; lane: string; provider: string; sessionId: string | null; runId: string | null;
    }[];
    let totalTokens = 0;
    let peakTokens = 0;
    let cachedTokens = 0;
    let inputTokens = 0;
    const byDay = new Map<string, DayBucket>();
    const daySet = new Set<string>();
    const providers: Record<string, number> = {};
    const tasks: Record<string, number> = {};
    const sessions = new Map<string, { min: number; max: number }>();
    for (const row of rows) {
      const tokens = row.inputTokens + row.outputTokens;
      totalTokens += tokens;
      peakTokens = Math.max(peakTokens, tokens);
      cachedTokens += row.cachedTokens;
      inputTokens += row.inputTokens;
      providers[row.provider] = (providers[row.provider] ?? 0) + tokens;
      const task = taskFor(row.type, row.lane);
      tasks[task] = (tasks[task] ?? 0) + tokens;
      const sessionKey = row.sessionId || row.runId;
      if (sessionKey) {
        const span = sessions.get(sessionKey) ?? { min: row.at, max: row.at };
        span.min = Math.min(span.min, row.at);
        span.max = Math.max(span.max, row.at);
        sessions.set(sessionKey, span);
      }
      const key = dayKey(row.at);
      daySet.add(key);
      const bucket = byDay.get(key) ?? emptyDay();
      bucket.tokens += tokens;
      bucket.credits += row.credits;
      bucket.cached += row.cachedTokens;
      bucket.input += row.inputTokens;
      addPart(bucket.models, row.model, row.credits, tokens);
      addPart(bucket.tools, row.type, row.credits, tokens);
      byDay.set(key, bucket);
    }
    const days = [...daySet].sort();
    const span = rows.length > 1 ? rows[rows.length - 1].at - rows[0].at : 0;
    let longestSessionMs = 0;
    for (const session of sessions.values()) longestSessionMs = Math.max(longestSessionMs, session.max - session.min);
    return {
      refreshedAt: now,
      plan: wallet.plan,
      includedBalance: wallet.includedBalance,
      purchasedBalance: wallet.purchasedBalance,
      windows: wallet.windows,
      cache: { cachedTokens, inputTokens },
      providers,
      tasks,
      activity: {
        totalTokens,
        peakTokens,
        durationMs: span,
        longestSessionMs,
        currentStreakDays: streakEnding(days, now),
        longestStreakDays: longestStreak(days),
      },
      days: days.map((day) => ({ day, ...byDay.get(day)! })),
    };
  }

  usageEvent(id: string) {
    return this.db.prepare(`SELECT * FROM usage_events WHERE id = ?`).get(id);
  }

  // ---------- internals ----------

  private tx(fn: () => void): void {
    if (this.inTx) { fn(); return; }
    this.db.exec("BEGIN IMMEDIATE");
    this.inTx = true;
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw err;
    } finally {
      this.inTx = false;
    }
  }
  private inTx = false;

  /** Appends one entry. Returns false (and writes nothing) when the key was already used. */
  private append(e: { accountId: string; type: EntryType; bucket: Bucket; amount: number; key: string; runId?: string | null; actor?: string | null; meta?: Record<string, unknown>; now: number }): boolean {
    const res = this.db.prepare(
      `INSERT INTO ledger_entries (id, account_id, type, bucket, amount, idempotency_key, run_id, actor, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(idempotency_key) DO NOTHING`,
    ).run(`le_${randomUUID()}`, e.accountId, e.type, e.bucket, Math.trunc(e.amount), e.key, e.runId ?? null, e.actor ?? null, JSON.stringify(e.meta ?? {}), e.now);
    return Number(res.changes) > 0;
  }

  /** A new cycle's grant: whatever included credit is left from the last cycle expires first. */
  private grant(accountId: string, planId: string, key: string, now: number, meta: Record<string, unknown>): boolean {
    if (this.entryByKey(key)) return false;
    const leftover = this.bucketSum(accountId, "included");
    if (leftover > 0) this.append({ accountId, type: "expiration", bucket: "included", amount: -leftover, key: `expire:${key}`, meta: { reason: "cycle_end" }, now });
    const plan = planById(planId);
    return this.append({ accountId, type: "monthly_grant", bucket: "included", amount: plan.monthlyCredits, key, meta, now });
  }

  private rollCycle(accountId: string, now: number): void {
    const w = this.wallet(accountId);
    if (!w || now < w.cycle_end) return;
    // Paid plans renew only on a paid invoice (webhook). Free renews on its own.
    if (w.plan_id !== DEFAULT_PLAN) return;
    let start = w.cycle_start;
    let end = w.cycle_end;
    while (now >= end) { start = end; end = start + CYCLE; }
    this.db.prepare(`UPDATE wallets SET cycle_start = ?, cycle_end = ? WHERE account_id = ?`).run(start, end, accountId);
    this.grant(accountId, DEFAULT_PLAN, `grant:${accountId}:free:${start}`, now, { plan: DEFAULT_PLAN, cycle: true });
  }

  /** Usage comes out of included credit first, then purchased; a run's hold shrinks by what it used. */
  private settle(accountId: string, credits: number, eventId: string, runId: string | null, meta: Record<string, unknown>, now: number): number {
    const hold = runId ? this.holdRemaining(runId) : 0;
    const spendable = Math.max(0, this.available(accountId) + hold);
    const charged = Math.min(credits, spendable);
    const shortfall = credits - charged;
    const m = shortfall > 0 ? { ...meta, shortfall } : meta;
    const included = Math.max(0, this.bucketSum(accountId, "included"));
    const fromIncluded = Math.min(included, charged);
    const fromPurchased = charged - fromIncluded;
    if (fromIncluded > 0) this.append({ accountId, type: "usage_settlement", bucket: "included", amount: -fromIncluded, key: `settle:${eventId}:i`, runId, meta: m, now });
    if (fromPurchased > 0) this.append({ accountId, type: "usage_settlement", bucket: "purchased", amount: -fromPurchased, key: `settle:${eventId}:p`, runId, meta: m, now });
    const fromHold = Math.min(hold, charged);
    if (fromHold > 0) this.append({ accountId, type: "reservation_release", bucket: "hold", amount: -fromHold, key: `settle:${eventId}:h`, runId, meta: { settled: true }, now });
    return charged;
  }

  private maybeAutoRecharge(accountId: string, now: number): void {
    const settings = this.autoRechargeRow(accountId);
    if (!settings) return;
    const w = this.wallet(accountId)!;
    if (this.available(accountId) >= settings.threshold) return;
    const requests = this.db.prepare(`SELECT n, status FROM auto_recharge_requests WHERE account_id = ? AND cycle_start = ? ORDER BY n`).all(accountId, w.cycle_start) as { n: number; status: string }[];
    if (requests.some((r) => r.status === "pending")) return; // one payment in flight at a time
    if (requests.length >= settings.max_per_month) return; // the monthly cap
    this.db.prepare(
      `INSERT INTO auto_recharge_requests (account_id, cycle_start, n, pack_id, status, created_at) VALUES (?, ?, ?, ?, 'pending', ?)`,
    ).run(accountId, w.cycle_start, requests.length + 1, settings.pack_id, now);
    for (const l of this.rechargeListeners) {
      try { l(accountId, settings.pack_id as PackId); } catch { /* the payment side logs its own failures */ }
    }
  }

  /** The payment side reports a failed auto-recharge so the next one can be tried (still within the cap). */
  autoRechargeFailed(accountId: string): void {
    this.db.prepare(`UPDATE auto_recharge_requests SET status = 'failed' WHERE account_id = ? AND status = 'pending'`).run(accountId);
  }

  private assertRunCap(accountId: string, runId: string, nextCostUsd: number, _now: number): void {
    const w = this.wallet(accountId)!;
    const plan = planById(w.plan_id);
    const spent = this.db.prepare(`SELECT COALESCE(SUM(provider_cost_micros), 0) AS n FROM usage_events WHERE run_id = ? AND ok = 1`).get(runId) as { n: number };
    const extra = (this.db.prepare(`SELECT extra_usd FROM run_budget WHERE run_id = ?`).get(runId) as { extra_usd: number } | undefined)?.extra_usd ?? 0;
    const next = spent.n / 1_000_000 + nextCostUsd;
    const cap = plan.perRunCostUsd + extra;
    if (nextCostUsd > 0 ? next > cap + 1e-9 : next >= cap - 1e-9) {
      throw new BillingLimitError(
        "RUN_CAP",
        `This run reached its autonomous budget ($${plan.perRunCostUsd.toFixed(2)} internal). Continue with more credits, switch to a lower-cost model, or stop.`,
      );
    }
  }

  private assertEntitlement(accountId: string, lane: Lane, type: string, now: number): void {
    const w = this.wallet(accountId)!;
    const plan = planById(w.plan_id);
    if (lane === "ultra") {
      const used = this.countLane(accountId, "ultra", now - 7 * DAY, now);
      if (plan.ultraPer7d <= 0 || used >= plan.ultraPer7d) {
        throw new BillingLimitError("ENTITLEMENT", plan.ultraPer7d <= 0 ? `${plan.label} does not include Ultra.` : `${plan.label} Ultra allowance is used for this week.`);
      }
    }
    if (lane === "deep") {
      const used = this.countLane(accountId, "deep", now - 7 * DAY, now);
      if (used >= plan.deepPer7d) throw new BillingLimitError("ENTITLEMENT", `${plan.label} Deep allowance is used for this week.`);
    }
    if (type === "image") {
      const pro = lane === "image_pro";
      const n5 = this.countImages(accountId, pro, now - 5 * HOUR, now);
      const n7 = this.countImages(accountId, pro, now - 7 * DAY, now);
      const cap5 = pro ? plan.proImages5h : plan.images5h;
      const cap7 = pro ? plan.proImages7d : plan.images7d;
      if (n5 >= cap5 || n7 >= cap7) {
        throw new BillingLimitError("IMAGE_BURST", "Image generation is paused until the burst window frees up.");
      }
    }
  }

  /** When the oldest charge in this rolling window leaves it. */
  private windowResetAt(accountId: string, now: number, spanMs: number): number {
    const row = this.db.prepare(
      `SELECT MIN(created_at) AS t FROM ledger_entries WHERE account_id = ? AND type = 'usage_settlement' AND created_at > ? AND created_at <= ?`,
    ).get(accountId, now - spanMs, now) as { t: number | null };
    return row?.t ? Number(row.t) + spanMs : now + spanMs;
  }

  /** Credits settled in (from, to] — straight from the ledger. */
  private windowCredits(accountId: string, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COALESCE(-SUM(amount), 0) AS n FROM ledger_entries WHERE account_id = ? AND type = 'usage_settlement' AND created_at > ? AND created_at <= ?`,
    ).get(accountId, from, to) as { n: number };
    return Number(row.n);
  }

  private countLane(accountId: string, lane: string, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND lane = ? AND ok = 1 AND created_at > ? AND created_at <= ?`,
    ).get(accountId, lane, from, to) as { n: number };
    return row.n;
  }

  private countImages(accountId: string, pro: boolean, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND type = 'image' AND ok = 1 AND created_at > ? AND created_at <= ? AND lane ${pro ? "=" : "!="} 'image_pro'`,
    ).get(accountId, from, to) as { n: number };
    return row.n;
  }

  private bucketSum(accountId: string, bucket: Bucket): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE account_id = ? AND bucket = ?`).get(accountId, bucket) as { n: number };
    return Number(row.n);
  }

  private available(accountId: string): number {
    return this.bucketSum(accountId, "included") + this.bucketSum(accountId, "purchased") - this.bucketSum(accountId, "hold");
  }

  private holdRemaining(runId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(amount), 0) AS n FROM ledger_entries WHERE run_id = ? AND bucket = 'hold'`).get(runId) as { n: number };
    return Math.max(0, Number(row.n));
  }

  private heldCount(accountId: string): number {
    const rows = this.db.prepare(
      `SELECT run_id, SUM(amount) AS n FROM ledger_entries WHERE account_id = ? AND bucket = 'hold' GROUP BY run_id HAVING n > 0`,
    ).all(accountId) as unknown[];
    return rows.length;
  }

  private entryByKey(key: string): LedgerEntry | null {
    const row = this.db.prepare(`SELECT * FROM ledger_entries WHERE idempotency_key = ?`).get(key) as any;
    return row ? rowToEntry(row) : null;
  }

  private wallet(accountId: string) {
    return this.db.prepare(`SELECT * FROM wallets WHERE account_id = ?`).get(accountId) as {
      account_id: string; plan_id: string; subscription_id: string | null; subscription_status: string; cycle_start: number; cycle_end: number; created_at: number;
    } | undefined;
  }

  private autoRechargeRow(accountId: string) {
    return this.db.prepare(`SELECT * FROM auto_recharge WHERE user_id = ?`).get(accountId) as {
      threshold: number; pack_id: string; max_per_month: number;
    } | undefined;
  }

  private autoRechargeView(accountId: string) {
    const row = this.autoRechargeRow(accountId);
    if (!row) return null;
    const w = this.wallet(accountId)!;
    const used = (this.db.prepare(`SELECT COUNT(*) AS n FROM auto_recharge_requests WHERE account_id = ? AND cycle_start = ? AND status != 'failed'`).get(accountId, w.cycle_start) as { n: number }).n;
    return { threshold: row.threshold, pack_id: row.pack_id, max_per_month: row.max_per_month, recharges_this_cycle: Number(used) };
  }

  private recent(accountId: string, limit: number) {
    return this.db.prepare(
      `SELECT id, type, lane, model, credits_charged, provider_cost_micros, created_at, ok FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(accountId, limit);
  }

  /** One-time move from the v1 mutable-balance tables: opening balances become attributed entries. */
  private migrateV1(): void {
    const hasV1 = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'`).get();
    if (!hasV1) return;
    const rows = this.db.prepare(`SELECT * FROM accounts`).all() as { user_id: string; plan_id: string; cycle_start: number; included_balance: number; purchased_balance: number }[];
    this.tx(() => {
      for (const r of rows) {
        if (this.wallet(r.user_id)) continue;
        this.db.prepare(
          `INSERT INTO wallets (account_id, plan_id, subscription_status, cycle_start, cycle_end, created_at) VALUES (?, ?, 'legacy', ?, ?, ?)`,
        ).run(r.user_id, planById(r.plan_id).id, r.cycle_start, r.cycle_start + CYCLE, r.cycle_start);
        const now = Date.now();
        if (r.included_balance > 0) this.append({ accountId: r.user_id, type: "monthly_grant", bucket: "included", amount: r.included_balance, key: `migrate:v1:${r.user_id}:included`, actor: "system:migration", meta: { plan: r.plan_id, migrated: true }, now });
        if (r.purchased_balance > 0) this.append({ accountId: r.user_id, type: "admin_adjustment", bucket: "purchased", amount: r.purchased_balance, key: `migrate:v1:${r.user_id}:purchased`, actor: "system:migration", meta: { reason: "Opening balance carried over from the v1 ledger" }, now });
      }
      this.db.exec(`ALTER TABLE accounts RENAME TO v1_accounts`);
    });
  }
}

function rowToEntry(r: any): LedgerEntry {
  return {
    id: r.id, accountId: r.account_id, type: r.type, bucket: r.bucket, amount: Number(r.amount), idempotencyKey: r.idempotency_key,
    runId: r.run_id ?? null, actor: r.actor ?? null, meta: JSON.parse(r.meta || "{}"), createdAt: Number(r.created_at),
  };
}
