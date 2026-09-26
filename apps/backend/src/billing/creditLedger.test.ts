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
  db.purchase("u1", "pack_5k", "checkout", t0);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.1, now: t0 + 1000 });
  const mid = db.snapshot("u1", t0 + 1000);
  assert.equal(mid.includedBalance, 4_000 - customerCreditsFor(0.1, 2.25).customerCredits);
  assert.equal(mid.purchasedBalance, 5_000);
  db.close();
  const again = new CreditLedger(path.join(dir, "billing.sqlite"));
  const after = again.snapshot("u1", t0 + 2000);
  assert.equal(after.includedBalance, mid.includedBalance);
  assert.equal(after.purchasedBalance, 5_000);
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
  assert.throws(() => db.charge({ userId: "u1", type: "model", lane: "ultra", providerCostUsd: 0.01, now: t0 + 1 }), (e: any) => e instanceof BillingLimitError && e.code === "ENTITLEMENT");
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
  assert.equal(snap.includedBalance, 10_000);
  db.close();
});

test("failed work is recorded and not charged", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 5);
  db.ensureAccount("u1", "pro", t0);
  const failed = db.charge({ userId: "u1", type: "model", lane: "build", providerCostUsd: 0.2, ok: false, now: t0 });
  assert.equal(failed.creditsCharged, 0);
  assert.equal(db.snapshot("u1", t0).includedBalance, 10_000);
  db.close();
});

test("auto-recharge fires once and stops at the monthly cap", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 6);
  db.setPlan("u1", "starter", t0);
  db.setAutoRecharge("u1", { threshold: 3_900, packId: "pack_5k", maxPerMonth: 1 }, t0);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 + 1 });
  const once = db.snapshot("u1", t0 + 1);
  assert.equal(once.purchasedBalance, 5_000);
  assert.equal(once.autoRecharge?.recharges_this_cycle, 1);
  db.charge({ userId: "u1", type: "model", lane: "auto", providerCostUsd: 0.2, now: t0 + 2 });
  assert.equal(db.snapshot("u1", t0 + 2).purchasedBalance, 5_000);
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

test("per-run cap stops a runaway and says so", () => {
  const { db } = ledger();
  const t0 = Date.UTC(2026, 8, 7);
  db.setPlan("u1", "pro", t0);
  db.purchase("u1", "pack_5k", "checkout", t0);
  assert.throws(
    () => db.charge({ userId: "u1", runId: "run_1", type: "model", lane: "utility", providerCostUsd: 1.6, now: t0 }),
    (e: any) => e.code === "RUN_CAP" && /autonomous budget/.test(e.message),
  );
  db.close();
});
