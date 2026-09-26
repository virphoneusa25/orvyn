import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { customerCreditsFor, providerCostUsd } from "./creditMath";
import { CREDIT_PACKS, LANE_FACTORS, type Lane, type PackId, type PlanId, packById, planById } from "./plans";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CYCLE = 30 * DAY;

export class BillingLimitError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
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

export class CreditLedger {
  private db: DatabaseSync;

  constructor(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        cycle_start INTEGER NOT NULL,
        included_balance INTEGER NOT NULL,
        purchased_balance INTEGER NOT NULL,
        reserved_balance INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        credits INTEGER NOT NULL,
        included_after INTEGER NOT NULL,
        purchased_after INTEGER NOT NULL,
        reserved_after INTEGER NOT NULL,
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS credit_reservations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        credits INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS top_up_orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        credits INTEGER NOT NULL,
        price_usd REAL NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auto_recharge (
        user_id TEXT PRIMARY KEY,
        threshold INTEGER NOT NULL,
        pack_id TEXT NOT NULL,
        max_per_month INTEGER NOT NULL,
        recharges_this_cycle INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS run_budget (
        run_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        extra_usd REAL NOT NULL DEFAULT 0
      );
    `);
    this.seedDefaultRateCard();
  }

  close(): void {
    this.db.close();
  }

  seedDefaultRateCard(now = Date.now()): void {
    const existing = this.db.prepare(`SELECT id FROM rate_cards WHERE model_id = 'default' AND effective_to IS NULL`).get();
    if (existing) return;
    this.db.prepare(
      `INSERT INTO rate_cards (id, provider, model_id, input_usd_per_million, cached_input_usd_per_million, output_usd_per_million, effective_from, effective_to)
       VALUES (?, 'orvyn', 'default', 0.2, 0.02, 0.8, ?, NULL)`,
    ).run(`rc_${randomUUID().slice(0, 8)}`, now);
  }

  /** New card takes effect now. The previous card for this model is closed, not rewritten. */
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

  ensureAccount(userId: string, planId: PlanId = "starter", now = Date.now()): void {
    const row = this.account(userId);
    if (!row) {
      const plan = planById(planId);
      this.db.prepare(
        `INSERT INTO accounts (user_id, plan_id, cycle_start, included_balance, purchased_balance, reserved_balance) VALUES (?, ?, ?, ?, 0, 0)`,
      ).run(userId, plan.id, now, plan.monthlyCredits);
      this.ledger(userId, "grant", plan.monthlyCredits, plan.monthlyCredits, 0, 0, { plan: plan.id }, now);
      return;
    }
    this.rollCycle(userId, now);
  }

  setPlan(userId: string, planId: PlanId, now = Date.now()): void {
    this.ensureAccount(userId, planId, now);
    const plan = planById(planId);
    const row = this.account(userId)!;
    this.db.prepare(`UPDATE accounts SET plan_id = ?, included_balance = ?, cycle_start = ? WHERE user_id = ?`).run(
      plan.id, plan.monthlyCredits, now, userId,
    );
    this.ledger(userId, "grant", plan.monthlyCredits, plan.monthlyCredits, row.purchased_balance, row.reserved_balance, { plan: plan.id, switched: true }, now);
  }

  purchase(userId: string, packId: PackId, source: "checkout" | "auto_recharge" = "checkout", now = Date.now()): { credits: number; priceUsd: number } {
    const pack = packById(packId);
    if (!pack) throw new BillingLimitError("PACK", "Unknown credit pack.");
    this.ensureAccount(userId, "starter", now);
    if (source === "auto_recharge") {
      const settings = this.autoRecharge(userId);
      if (!settings) throw new BillingLimitError("RECHARGE", "Auto-recharge is not turned on.");
      if (settings.recharges_this_cycle >= settings.max_per_month) {
        throw new BillingLimitError("RECHARGE_CAP", "This month's auto-recharge limit has been reached.");
      }
      this.db.prepare(`UPDATE auto_recharge SET recharges_this_cycle = recharges_this_cycle + 1 WHERE user_id = ?`).run(userId);
    }
    const row = this.account(userId)!;
    const purchased = row.purchased_balance + pack.credits;
    this.db.prepare(`UPDATE accounts SET purchased_balance = ? WHERE user_id = ?`).run(purchased, userId);
    this.db.prepare(
      `INSERT INTO top_up_orders (id, user_id, pack_id, credits, price_usd, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(`ord_${randomUUID().slice(0, 8)}`, userId, pack.id, pack.credits, pack.priceUsd, source, now);
    this.ledger(userId, source === "auto_recharge" ? "recharge" : "topup", pack.credits, row.included_balance, purchased, row.reserved_balance, { pack: pack.id, priceUsd: pack.priceUsd }, now);
    return { credits: pack.credits, priceUsd: pack.priceUsd };
  }

  setAutoRecharge(userId: string, input: { threshold: number; packId: PackId; maxPerMonth: number }, now = Date.now()): void {
    this.ensureAccount(userId, "starter", now);
    if (!packById(input.packId)) throw new BillingLimitError("PACK", "Unknown credit pack.");
    if (input.maxPerMonth < 1) throw new BillingLimitError("RECHARGE", "Set a monthly maximum of at least 1.");
    this.db.prepare(
      `INSERT INTO auto_recharge (user_id, threshold, pack_id, max_per_month, recharges_this_cycle)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(user_id) DO UPDATE SET threshold = excluded.threshold, pack_id = excluded.pack_id, max_per_month = excluded.max_per_month`,
    ).run(userId, input.threshold, input.packId, input.maxPerMonth);
  }

  reserve(userId: string, runId: string, credits: number, now = Date.now()): string {
    this.ensureAccount(userId, "starter", now);
    const row = this.account(userId)!;
    const plan = planById(row.plan_id);
    const held = this.heldCount(userId);
    if (held >= plan.concurrentRuns) {
      throw new BillingLimitError("CONCURRENCY", `${plan.label} allows ${plan.concurrentRuns} agent run${plan.concurrentRuns === 1 ? "" : "s"} at a time.`);
    }
    const available = row.included_balance + row.purchased_balance - row.reserved_balance;
    if (credits > available) {
      throw new BillingLimitError("BALANCE", `This run needs ${credits} credits and ${available} are available.`);
    }
    const id = `rsv_${randomUUID().slice(0, 8)}`;
    const reserved = row.reserved_balance + credits;
    this.db.prepare(`UPDATE accounts SET reserved_balance = ? WHERE user_id = ?`).run(reserved, userId);
    this.db.prepare(
      `INSERT INTO credit_reservations (id, user_id, run_id, credits, status, created_at) VALUES (?, ?, ?, ?, 'held', ?)`,
    ).run(id, userId, runId, credits, now);
    this.ledger(userId, "reserve", credits, row.included_balance, row.purchased_balance, reserved, { runId }, now);
    return id;
  }

  release(runId: string, now = Date.now()): void {
    const rsv = this.db.prepare(`SELECT * FROM credit_reservations WHERE run_id = ? AND status = 'held'`).get(runId) as any;
    if (!rsv) return;
    const row = this.account(rsv.user_id)!;
    const reserved = Math.max(0, row.reserved_balance - rsv.credits);
    this.db.prepare(`UPDATE accounts SET reserved_balance = ? WHERE user_id = ?`).run(reserved, rsv.user_id);
    this.db.prepare(`UPDATE credit_reservations SET status = 'released' WHERE id = ?`).run(rsv.id);
    this.ledger(rsv.user_id, "release", rsv.credits, row.included_balance, row.purchased_balance, reserved, { runId }, now);
  }

  /** Charge a metered event. Failed work (ok: false) is recorded and not billed. */
  charge(input: UsageChargeInput): { creditsCharged: number; providerCostUsd: number; eventId: string } {
    const now = input.now ?? Date.now();
    this.ensureAccount(input.userId, "starter", now);
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
    if (billable > 0) {
      this.assertEntitlement(input.userId, lane, input.type, now);
      this.assertWindows(input.userId, billable, now);
      if (input.runId) this.assertRunCap(input.userId, input.runId, cost, now);
      this.debit(input.userId, billable, now, { runId: input.runId, lane, type: input.type });
    }
    const id = `use_${randomUUID().slice(0, 8)}`;
    this.db.prepare(
      `INSERT INTO usage_events (id, user_id, organization_id, session_id, run_id, type, provider, model, lane, input_tokens, cached_input_tokens, output_tokens, provider_cost_micros, credits_charged, rate_card_id, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, input.userId, input.organizationId ?? null, input.sessionId ?? null, input.runId ?? null, input.type,
      input.provider ?? null, input.model ?? null, lane,
      input.inputTokens ?? null, input.cachedInputTokens ?? null, input.outputTokens ?? null,
      Math.round(cost * 1_000_000), billable, card?.id ?? null, input.ok === false ? 0 : 1, now,
    );
    return { creditsCharged: billable, providerCostUsd: cost, eventId: id };
  }

  authorizeRun(userId: string, runId: string): void {
    const row = this.account(userId);
    const plan = planById(row?.plan_id ?? "starter");
    this.db.prepare(
      `INSERT INTO run_budget (run_id, user_id, extra_usd) VALUES (?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET extra_usd = extra_usd + ?`,
    ).run(runId, userId, plan.perRunCostUsd, plan.perRunCostUsd);
  }

  snapshot(userId: string, now = Date.now()) {
    this.ensureAccount(userId, "starter", now);
    const row = this.account(userId)!;
    const plan = planById(row.plan_id);
    const available = row.included_balance + row.purchased_balance - row.reserved_balance;
    const used5h = this.windowCredits(userId, now - 5 * HOUR, now);
    const used7d = this.windowCredits(userId, now - 7 * DAY, now);
    const cycleUsed = Math.max(0, plan.monthlyCredits - row.included_balance);
    const burst = row.purchased_balance > 0;
    const limit5h = burst ? plan.burst5h : plan.rolling5h;
    return {
      plan: { id: plan.id, label: plan.label, priceLabel: plan.priceLabel },
      includedBalance: row.included_balance,
      purchasedBalance: row.purchased_balance,
      reservedBalance: row.reserved_balance,
      availableBalance: available,
      windows: {
        fiveHour: { used: used5h, limit: limit5h, resetAt: this.windowResetAt(userId, now, 5 * HOUR) },
        sevenDay: { used: used7d, limit: plan.rolling7d, resetAt: this.windowResetAt(userId, now, 7 * DAY) },
        cycle: { used: cycleUsed, limit: plan.monthlyCredits, resetAt: row.cycle_start + CYCLE },
      },
      packs: CREDIT_PACKS,
      autoRecharge: this.autoRecharge(userId),
      recent: this.recent(userId, 12),
      note: "Stripe is not connected. Credit packs are recorded on this account immediately so the wallet can be tested.",
    };
  }

  usageEvent(id: string) {
    return this.db.prepare(`SELECT * FROM usage_events WHERE id = ?`).get(id);
  }

  private debit(userId: string, credits: number, now: number, meta: Record<string, unknown>): void {
    const row = this.account(userId)!;
    const settings = this.autoRecharge(userId);
    let included = row.included_balance;
    let purchased = row.purchased_balance;
    const projected = included + purchased - row.reserved_balance - credits;
    if (settings && projected < settings.threshold) {
      try {
        this.purchase(userId, settings.pack_id as PackId, "auto_recharge", now);
      } catch {
        /* monthly cap — the balance check below still applies */
      }
    }
    const fresh = this.account(userId)!;
    included = fresh.included_balance;
    purchased = fresh.purchased_balance;
    if (credits > included + purchased - fresh.reserved_balance) {
      throw new BillingLimitError("BALANCE", `Not enough credits. This step needs ${credits} and ${included + purchased - fresh.reserved_balance} are available.`);
    }
    let rest = credits;
    const fromIncluded = Math.min(included, rest);
    included -= fromIncluded;
    rest -= fromIncluded;
    purchased -= rest;
    this.db.prepare(`UPDATE accounts SET included_balance = ?, purchased_balance = ? WHERE user_id = ?`).run(included, purchased, userId);
    this.ledger(userId, "usage", -credits, included, purchased, fresh.reserved_balance, meta, now);
  }

  private assertWindows(userId: string, credits: number, now: number): void {
    const row = this.account(userId)!;
    const plan = planById(row.plan_id);
    const limit5h = row.purchased_balance > 0 ? plan.burst5h : plan.rolling5h;
    const used5h = this.windowCredits(userId, now - 5 * HOUR, now);
    if (used5h + credits > limit5h) {
      throw new BillingLimitError("WINDOW_5H", `The 5-hour limit is ${limit5h} credits. ${used5h} are already used in this window.`);
    }
    const used7d = this.windowCredits(userId, now - 7 * DAY, now);
    if (used7d + credits > plan.rolling7d) {
      throw new BillingLimitError("WINDOW_7D", `The 7-day limit is ${plan.rolling7d} credits. ${used7d} are already used.`);
    }
  }

  private assertRunCap(userId: string, runId: string, nextCostUsd: number, _now: number): void {
    const row = this.account(userId)!;
    const plan = planById(row.plan_id);
    const spent = this.db.prepare(`SELECT COALESCE(SUM(provider_cost_micros), 0) AS n FROM usage_events WHERE run_id = ? AND ok = 1`).get(runId) as { n: number };
    const extra = (this.db.prepare(`SELECT extra_usd FROM run_budget WHERE run_id = ?`).get(runId) as { extra_usd: number } | undefined)?.extra_usd ?? 0;
    const next = spent.n / 1_000_000 + nextCostUsd;
    if (next > plan.perRunCostUsd + extra + 1e-9) {
      throw new BillingLimitError(
        "RUN_CAP",
        `This run reached its autonomous budget ($${plan.perRunCostUsd.toFixed(2)} internal). Continue with more credits, switch to a lower-cost model, or stop.`,
      );
    }
  }

  private assertEntitlement(userId: string, lane: Lane, type: string, now: number): void {
    const row = this.account(userId)!;
    const plan = planById(row.plan_id);
    if (lane === "ultra") {
      const used = this.countLane(userId, "ultra", now - 7 * DAY, now);
      if (plan.ultraPer7d <= 0 || used >= plan.ultraPer7d) {
        throw new BillingLimitError("ENTITLEMENT", plan.ultraPer7d <= 0 ? `${plan.label} does not include Ultra.` : `${plan.label} Ultra allowance is used for this week.`);
      }
    }
    if (lane === "deep") {
      const used = this.countLane(userId, "deep", now - 7 * DAY, now);
      if (used >= plan.deepPer7d) throw new BillingLimitError("ENTITLEMENT", `${plan.label} Deep allowance is used for this week.`);
    }
    if (type === "image") {
      const since5 = now - 5 * HOUR;
      const since7 = now - 7 * DAY;
      const pro = lane === "image_pro";
      const n5 = this.countImages(userId, pro, since5, now);
      const n7 = this.countImages(userId, pro, since7, now);
      const cap5 = pro ? plan.proImages5h : plan.images5h;
      const cap7 = pro ? plan.proImages7d : plan.images7d;
      if (n5 >= cap5 || n7 >= cap7) {
        throw new BillingLimitError("IMAGE_BURST", "Image generation is paused until the burst window frees up.");
      }
    }
  }

  /** When the oldest charge in this rolling window leaves it. A full window resets one span from now. */
  private windowResetAt(userId: string, now: number, spanMs: number): number {
    const row = this.db.prepare(
      `SELECT MIN(created_at) AS t FROM usage_events WHERE user_id = ? AND credits_charged > 0 AND created_at > ? AND created_at <= ?`,
    ).get(userId, now - spanMs, now) as { t: number | null };
    return row?.t ? Number(row.t) + spanMs : now + spanMs;
  }

  private windowCredits(userId: string, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COALESCE(SUM(credits_charged), 0) AS n FROM usage_events WHERE user_id = ? AND created_at > ? AND created_at <= ?`,
    ).get(userId, from, to) as { n: number };
    return row.n;
  }

  private countLane(userId: string, lane: string, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND lane = ? AND ok = 1 AND created_at > ? AND created_at <= ?`,
    ).get(userId, lane, from, to) as { n: number };
    return row.n;
  }

  private countImages(userId: string, pro: boolean, from: number, to: number): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM usage_events WHERE user_id = ? AND type = 'image' AND ok = 1 AND created_at > ? AND created_at <= ? AND lane ${pro ? "=" : "!="} 'image_pro'`,
    ).get(userId, from, to) as { n: number };
    return row.n;
  }

  private heldCount(userId: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM credit_reservations WHERE user_id = ? AND status = 'held'`).get(userId) as { n: number };
    return row.n;
  }

  private rollCycle(userId: string, now: number): void {
    const row = this.account(userId);
    if (!row || now - row.cycle_start < CYCLE) return;
    const plan = planById(row.plan_id);
    this.db.prepare(`UPDATE accounts SET included_balance = ?, cycle_start = ? WHERE user_id = ?`).run(plan.monthlyCredits, now, userId);
    this.db.prepare(`UPDATE auto_recharge SET recharges_this_cycle = 0 WHERE user_id = ?`).run(userId);
    this.ledger(userId, "grant", plan.monthlyCredits, plan.monthlyCredits, row.purchased_balance, row.reserved_balance, { cycle: true }, now);
  }

  private account(userId: string) {
    return this.db.prepare(`SELECT * FROM accounts WHERE user_id = ?`).get(userId) as {
      user_id: string; plan_id: string; cycle_start: number; included_balance: number; purchased_balance: number; reserved_balance: number;
    } | undefined;
  }

  private autoRecharge(userId: string) {
    return this.db.prepare(`SELECT * FROM auto_recharge WHERE user_id = ?`).get(userId) as {
      threshold: number; pack_id: string; max_per_month: number; recharges_this_cycle: number;
    } | undefined;
  }

  private recent(userId: string, limit: number) {
    return this.db.prepare(
      `SELECT id, type, lane, model, credits_charged, provider_cost_micros, created_at, ok FROM usage_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    ).all(userId, limit);
  }

  private ledger(userId: string, kind: string, credits: number, included: number, purchased: number, reserved: number, meta: Record<string, unknown>, now: number): void {
    this.db.prepare(
      `INSERT INTO credit_transactions (id, user_id, kind, credits, included_after, purchased_after, reserved_after, meta, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(`txn_${randomUUID().slice(0, 8)}`, userId, kind, credits, included, purchased, reserved, JSON.stringify(meta), now);
  }
}
