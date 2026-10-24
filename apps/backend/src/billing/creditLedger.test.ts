import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CreditLedger, BillingLimitError } from "./CreditLedger";
import { customerCreditsFor } from "./creditMath";

function ledger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-bill-"));
  const db = new CreditLedger(path.join(dir, "billing.sqlite"));
  return { db, dir };
}

test("credit math matches the spec examples", () => {
  const coded = customerCreditsFor(0.042, 2.5);
  assert.equal(coded.baseCredits, 42);
  assert.equal(coded.customerCredits, 105);
  assert.equal(customerCreditsFor(0.05, 3).customerCredits, 150);
  assert.equal(customerCreditsFor(0.7, 2.5).customerCredits, 1750);
});

test("wallet spends included credits first and survives a new ledger on the same file", () => {
  const { db, dir } = ledger();
  const t0 = Date.UTC(2026, 8, 1);
  db.ensureAccount("u1", "starter", t0);
  db.purchase("u1", "pack_10k", "checkout", t0);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.1, now: t0 + 1000 });
  const mid = db.snapshot("u1", t0 + 1000);
  assert.equal(mid.includedBalance, 24_000 - customerCreditsFor(0.1, 2.25).customerCredits);
  assert.equal(mid.purchasedBalance, 10_000);
  db.close();
  const again = new CreditLedger(path.join(dir, "billing.sqlite"));
  const after = again.snapshot("u1", t0 + 2000);
  assert.equal(after.includedBalance, mid.includedBalance);
  assert.equal(after.purchasedBalance, 10_000);
  again.close();
});

test("a new rate card prices new usage and leaves the recorded cost unchanged", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 2);
  db.setPlan("u1", "pro", t0);
  db.setRateCard({ provider: "acme", modelId: "small", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2, effectiveFrom: t0 });
  const first = db.charge({ userId: "u1", type: "model", provider: "acme", model: "small", lane: "utility", inputTokens: 200_000, outputTokens: 0, now: t0 + 10 });
  db.setRateCard({ provider: "acme", modelId: "small", inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 8, effectiveFrom: t0 + 50 });
  const second = db.charge({ userId: "u1", type: "model", provider: "acme", model: "small", lane: "utility", inputTokens: 200_000, outputTokens: 0, now: t0 + 80 });
  assert.equal(first.providerCostUsd, 0.2);
  assert.equal(second.providerCostUsd, 0.8);
  assert.equal((db.usageEvent(first.eventId) as any).provider_cost_micros, 200_000);
  db.close();
});

test("starter cannot use Ultra and rolling capacity returns as events age out", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 3);
  db.ensureAccount("u1", "starter", t0);
  assert.throws(() => db.assertCanSpend("u1", undefined, t0 + 1, { lane: "ultra" }), (e: any) => e instanceof BillingLimitError && e.code === "ENTITLEMENT");
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 });
  const inside = db.snapshot("u1", t0 + 60_000);
  assert.ok(inside.windows.fiveHour.used > 0);
  const later = db.snapshot("u1", t0 + 6 * 3_600_000);
  assert.equal(later.windows.fiveHour.used, 0);
  assert.ok(later.windows.sevenDay.used > 0);
  db.close();
});

test("two reservations cannot overspend one wallet", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 4);
  db.setPlan("u1", "pro", t0);
  db.reserve("u1", "run_a", 6_000, t0);
  db.reserve("u1", "run_b", 4_000, t0);
  assert.throws(() => db.reserve("u1", "run_c", 1, t0), (e: any) => e.code === "CONCURRENCY" || e.code === "BALANCE");
  db.release("run_a", t0 + 1);
  const snap = db.snapshot("u1", t0 + 2);
  assert.equal(snap.reservedBalance, 4_000);
  assert.equal(snap.includedBalance, 60_000);
  db.close();
});

test("failed work is recorded and not charged", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 5);
  db.ensureAccount("u1", "pro", t0);
  const failed = db.charge({ userId: "u1", type: "model", lane: "build", providerCostUsd: 0.2, ok: false, now: t0 });
  assert.equal(failed.creditsCharged, 0);
  assert.equal(db.snapshot("u1", t0).includedBalance, 60_000);
  db.close();
});

test("auto-recharge asks for a payment once, credits only when paid, and stops at the monthly cap", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 6);
  db.setPlan("u1", "starter", t0);
  const asked: string[] = [];
  db.onAutoRecharge((acct, pack) => asked.push(`${acct}:${pack}`));
  db.setAutoRecharge("u1", { threshold: 23_900, packId: "pack_10k", maxPerMonth: 1 }, t0);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 + 1 });
  assert.deepEqual(asked, ["u1:pack_10k"], "one payment request");
  assert.equal(db.snapshot("u1", t0 + 1).purchasedBalance, 0, "no credits before the payment succeeds");
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 + 2 });
  assert.equal(asked.length, 1, "no second request while one is in flight");
  db.creditPurchase("u1", "pack_10k", { paymentRef: "pi_auto_1", source: "auto_recharge" }, t0 + 3);
  assert.equal(db.snapshot("u1", t0 + 3).purchasedBalance, 10_000);
  assert.equal(db.snapshot("u1", t0 + 3).autoRecharge?.recharges_this_cycle, 1);
  db.adminAdjust("u1", -33_000, { actor: "test", reason: "drain", bucket: "purchased" }, t0 + 4);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 + 5 });
  assert.equal(asked.length, 1, "the monthly cap holds");
  db.close();
});

test("rolling windows name the moment the oldest charge leaves", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 8, 12);
  db.setPlan("u1", "pro", t0);
  db.charge({ userId: "u1", type: "model", lane: "utility", providerCostUsd: 0.05, now: t0 + 1000 });
  const snap = db.snapshot("u1", t0 + 60_000);
  assert.equal(snap.windows.fiveHour.resetAt, t0 + 1000 + 5 * 3_600_000);
  assert.equal(snap.windows.cycle.resetAt, t0 + 30 * 24 * 3_600_000);
  assert.ok(snap.windows.fiveHour.used > 0);
  db.close();
});

test("usage stats roll tokens, cache, and streaks and skip failed calls", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 10, 12);
  db.setPlan("u1", "pro", t0);
  db.charge({
    userId: "u1", type: "model", model: "ORVYN-5.3", lane: "utility", provider: "orvyn", runId: "run_stats",
    inputTokens: 1_000, cachedInputTokens: 250, outputTokens: 100, providerCostUsd: 0.05, now: t0,
  });
  db.charge({
    userId: "u1", type: "search", model: "ORVYN-5.3", lane: "search",
    inputTokens: 400, outputTokens: 20, providerCostUsd: 0.01, ok: false, now: t0 + 1_000,
  });
  const stats = db.usageStats("u1", t0 + 60_000);
  assert.equal(stats.plan.id, "pro");
  assert.equal(stats.activity.totalTokens, 1_100);
  assert.equal(stats.activity.peakTokens, 1_100);
  assert.equal(stats.activity.currentStreakDays, 1);
  assert.equal(stats.cache.cachedTokens, 250);
  assert.equal(stats.cache.inputTokens, 1_000);
  assert.equal(stats.days.length, 1);
  assert.equal(stats.days[0].day, "2026-09-10");
  assert.ok(stats.days[0].models["ORVYN-5.3"].credits > 0);
  assert.equal(stats.days[0].tools.model.tokens, 1_100);
  assert.equal(stats.days[0].tools.search, undefined);
  assert.equal(stats.activity.longestSessionMs, 0);
  assert.equal(stats.tasks["General chat"], 1_100);
  assert.equal(stats.providers.orvyn, 1_100);
  db.close();
});

test("per-run cap stops a runaway before its next call and says so", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 7);
  db.setPlan("u1", "pro", t0);
  db.purchase("u1", "pack_10k", "checkout", t0);
  db.charge({ userId: "u1", runId: "run_1", type: "model", lane: "utility", providerCostUsd: 1.6, now: t0 });
  assert.throws(
    () => db.assertCanSpend("u1", "run_1", t0 + 1),
    (e: any) => e.code === "RUN_CAP" && /autonomous budget/.test(e.message),
  );
  db.close();
});

test("new accounts start on Free with 2,000 credits, granted once", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 28);
  db.ensureAccount("new-user", undefined, t0);
  db.ensureAccount("new-user", undefined, t0 + 5);
  const snap = db.snapshot("new-user", t0 + 10);
  assert.equal(snap.includedBalance, 2_000);
  assert.equal((snap as any).planId ?? (snap as any).plan?.id ?? "free", "free");
  db.close();
});

test("ledger entries are immutable: no update, no delete", () => {
  const { db, dir } = ledger();
  db.ensureAccount("u1", undefined, 1_000);
  db.close();
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(dir, "billing.sqlite"));
  assert.throws(() => raw.prepare("UPDATE ledger_entries SET amount = 999999").run(), /immutable/);
  assert.throws(() => raw.prepare("DELETE FROM ledger_entries").run(), /immutable/);
  raw.close();
});

test("a subscription period grants once, however many times the webhook arrives", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 1);
  db.ensureAccount("acct", undefined, t0);
  const sub = { accountId: "acct", planId: "pro" as const, subscriptionId: "sub_1", periodStart: t0, periodEnd: t0 + 30 * 86_400_000, status: "active" };
  assert.equal(db.applySubscription(sub, t0 + 1).granted, true);
  assert.equal(db.applySubscription(sub, t0 + 2).granted, false);
  assert.equal(db.applySubscription(sub, t0 + 3).granted, false);
  const snap = db.snapshot("acct", t0 + 4);
  assert.equal(snap.includedBalance, 60_000, "Free leftover expired, Pro granted once");
  assert.equal(db.grantsIssued("acct").length, 2, "signup grant + one Pro grant");
  const renewal = { ...sub, periodStart: sub.periodEnd, periodEnd: sub.periodEnd + 30 * 86_400_000 };
  assert.equal(db.applySubscription(renewal, renewal.periodStart + 1).granted, true, "the next period grants again");
  assert.equal(db.applySubscription(renewal, renewal.periodStart + 2).granted, false);
  assert.ok(db.verify("acct").ok);
  db.close();
});

test("a paid plan never renews itself; Free does, once per cycle, expiring the leftover", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 2);
  db.ensureAccount("free1", undefined, t0);
  db.charge({ userId: "free1", type: "model", lane: "utility", providerCostUsd: 0.1, now: t0 + 10 });
  const later = t0 + 31 * 86_400_000;
  db.ensureAccount("free1", undefined, later);
  db.ensureAccount("free1", undefined, later + 1);
  assert.equal(db.snapshot("free1", later + 2).includedBalance, 2_000);
  assert.equal(db.grantsIssued("free1").length, 2);
  db.ensureAccount("paid1", undefined, t0);
  db.applySubscription({ accountId: "paid1", planId: "starter", subscriptionId: "sub_p", periodStart: t0, periodEnd: t0 + 30 * 86_400_000, status: "active" }, t0);
  db.ensureAccount("paid1", undefined, later);
  assert.equal(db.grantsIssued("paid1").length, 2, "no renewal grant without a paid invoice");
  db.close();
});

test("top-ups and usage are idempotent: replays never double-credit or double-charge", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 3);
  db.ensureAccount("u1", undefined, t0);
  assert.equal(db.creditPurchase("u1", "pack_10k", { paymentRef: "evt_1" }, t0).duplicate, false);
  assert.equal(db.creditPurchase("u1", "pack_10k", { paymentRef: "evt_1" }, t0 + 1).duplicate, true);
  assert.equal(db.snapshot("u1", t0 + 2).purchasedBalance, 10_000);
  const first = db.charge({ userId: "u1", eventId: "use_same", type: "model", lane: "utility", providerCostUsd: 0.1, now: t0 + 3 });
  const replay = db.charge({ userId: "u1", eventId: "use_same", type: "model", lane: "utility", providerCostUsd: 0.1, now: t0 + 4 });
  assert.ok(first.creditsCharged > 0);
  assert.equal(replay.creditsCharged, 0);
  assert.equal(db.snapshot("u1", t0 + 5).availableBalance, 12_000 - first.creditsCharged);
  db.close();
});

test("reserve → settle → release: a run's hold shrinks as it spends and the rest comes back", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 4);
  db.ensureAccount("u1", undefined, t0);
  db.reserve("u1", "run_x", 500, t0);
  db.reserve("u1", "run_x", 500, t0 + 1); // idempotent per run
  assert.equal(db.snapshot("u1", t0 + 1).availableBalance, 1_500);
  const used = db.charge({ userId: "u1", runId: "run_x", type: "model", lane: "utility", providerCostUsd: 0.1, now: t0 + 2 }).creditsCharged;
  const mid = db.snapshot("u1", t0 + 2);
  assert.equal(mid.reservedBalance, 500 - used);
  assert.equal(mid.availableBalance, 1_500, "spending inside the hold does not reduce what else is available");
  db.release("run_x", t0 + 3);
  db.release("run_x", t0 + 4);
  const end = db.snapshot("u1", t0 + 5);
  assert.equal(end.reservedBalance, 0);
  assert.equal(end.availableBalance, 2_000 - used);
  db.close();
});

test("an empty wallet stops the next call; an overrun is recorded as a shortfall, never below zero", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 5);
  db.ensureAccount("u1", undefined, t0);
  const big = db.charge({ userId: "u1", type: "model", lane: "utility", providerCostUsd: 5, now: t0 + 1 });
  assert.equal(big.creditsCharged, 2_000, "charged what was there");
  assert.equal(db.snapshot("u1", t0 + 2).availableBalance, 0);
  assert.ok(db.verify("u1").ok, "no bucket below zero");
  assert.throws(() => db.assertCanSpend("u1", undefined, t0 + 3), (e: any) => e.code === "BALANCE");
  db.close();
});

test("rolling windows come from ledger settlements and gate the next call", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 9, 6);
  db.ensureAccount("u1", undefined, t0);
  db.charge({ userId: "u1", type: "model", lane: "utility", providerCostUsd: 0.3, now: t0 + 1 }); // 525 credits > 500 (5h)
  assert.throws(() => db.assertCanSpend("u1", undefined, t0 + 2), (e: any) => e.code === "WINDOW_5H");
  assert.doesNotThrow(() => db.assertCanSpend("u1", undefined, t0 + 6 * 3_600_000));
  db.close();
});

test("staff adjustments need an actor and a reason", () => {
  const { db } = ledger();
  db.ensureAccount("u1", undefined, 1);
  assert.throws(() => db.adminAdjust("u1", 100, { actor: "", reason: "x" }), /staff member/);
  assert.throws(() => db.adminAdjust("u1", 100, { actor: "a@orvyn", reason: " " }), /reason/);
  const e = db.adminAdjust("u1", 100, { actor: "a@orvyn", reason: "goodwill" }, 2);
  assert.equal(e.type, "admin_adjustment");
  assert.equal(e.actor, "a@orvyn");
  db.close();
});

test("v1 balances migrate once into attributed opening entries", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-bill-v1-"));
  const file = path.join(dir, "billing.sqlite");
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(file);
  raw.exec(`CREATE TABLE accounts (user_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, cycle_start INTEGER NOT NULL, included_balance INTEGER NOT NULL, purchased_balance INTEGER NOT NULL, reserved_balance INTEGER NOT NULL)`);
  raw.prepare(`INSERT INTO accounts VALUES ('old', 'pro', ?, 1234, 500, 0)`).run(Date.now());
  raw.close();
  const db = new CreditLedger(file);
  const snap = db.snapshot("old");
  assert.equal(snap.includedBalance, 1234);
  assert.equal(snap.purchasedBalance, 500);
  assert.equal(snap.plan.id, "pro");
  db.close();
  const again = new CreditLedger(file);
  assert.equal(again.snapshot("old").purchasedBalance, 500, "not migrated twice");
  again.close();
});

test("exact HF quotes remain versioned when calls finish after a price refresh", () => {
  const { db, dir } = ledger();
  try {
    const t0 = Date.now();
    const card = { provider: "huggingface", modelId: "hf:zai-org/GLM-5.3:deepinfra", inputUsdPerMillion: 0.9, cachedInputUsdPerMillion: 0.9, outputUsdPerMillion: 4 };
    db.setRateCard({ ...card, effectiveFrom: t0 });
    db.setRateCard({ ...card, inputUsdPerMillion: 1.4, effectiveFrom: t0 + 1000 });
    const oldCall = db.charge({ userId: "fixture", type: "model", provider: card.provider, model: card.modelId, inputTokens: 1_000_000, outputTokens: 0, now: t0 + 2000, rateAt: t0 });
    assert.equal(oldCall.providerCostUsd, 0.9);
    const nextCall = db.charge({ userId: "fixture", type: "model", provider: card.provider, model: card.modelId, inputTokens: 1_000_000, outputTokens: 0, now: t0 + 2001 });
    assert.equal(nextCall.providerCostUsd, 1.4);
    // A late quote must not close the later version or reprice historical usage.
    db.setRateCard({ ...card, inputUsdPerMillion: 1, effectiveFrom: t0 + 500 });
    assert.equal(db.rateCardAt(card.provider, card.modelId, t0 + 1500)?.inputUsdPerMillion, 1.4);
    assert.equal(db.rateCardAt(card.provider, card.modelId, t0 + 750)?.inputUsdPerMillion, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
