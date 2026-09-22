// apps/desktop/src/renderer/contextUsage.test.ts
//
// Popover math must be boring and exact: percentages from real values,
// categories as shares of USED context, cache only when reported, quotas
// only when a limit actually exists.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contextPercent,
  severityOf,
  contextWarning,
  exceedsLimit,
  categoryShares,
  cacheHitRate,
  quotaFromServer,
  formatTokens,
} from "./contextUsage.ts";

test("context percent: real used / real limit, clamped", () => {
  assert.equal(contextPercent({ totalUsed: 445_000, contextLimit: 1_000_000 }), 0.445);
  assert.equal(contextPercent({ totalUsed: 0, contextLimit: 128_000 }), 0);
  assert.equal(contextPercent(null), null);
  assert.equal(contextPercent({ totalUsed: 10, contextLimit: 0 }), null, "no limit known → null, not a guess");
});

test("severity thresholds: calm until 70, elevated 85, warning 95", () => {
  assert.equal(severityOf(0.10), "normal");
  assert.equal(severityOf(0.699), "normal");
  assert.equal(severityOf(0.70), "elevated");
  assert.equal(severityOf(0.85), "warning");
  assert.equal(severityOf(0.95), "critical");
  assert.equal(severityOf(null), "normal");
});

test("high-context warnings: getting full at 85%, nearly full at 95%", () => {
  assert.equal(contextWarning(0.84), null);
  assert.equal(contextWarning(0.85), "Context is getting full");
  assert.equal(contextWarning(0.95), "Context nearly full");
  assert.equal(contextWarning(0.99), "Context nearly full");
});

test("model switch: exceeding the new model's window is detected", () => {
  const usage = { totalUsed: 200_000, contextLimit: 1_000_000 };
  assert.equal(exceedsLimit(usage, 128_000), true);
  assert.equal(exceedsLimit(usage, 1_000_000), false);
  assert.equal(exceedsLimit(null, 128_000), false);
  assert.equal(exceedsLimit(usage, null), false);
});

test("category shares: only measured categories, share of USED context, sorted", () => {
  const shares = categoryShares({
    totalUsed: 100_000,
    contextLimit: 1_000_000,
    categories: { messages: 72_400, toolDefinitions: 11_200, projectContext: 9_100, systemPrompt: 3_200, memory: 1_000, skills: 0 },
  });
  assert.deepEqual(shares.map((s) => s.key), ["messages", "toolDefinitions", "projectContext", "systemPrompt", "memory"]);
  // Shares are relative to the MEASURED total (96,900 here) so the visible
  // rows always sum to 100% of what the breakdown can attribute.
  assert.ok(Math.abs(shares[0].share - 72400 / 96900) < 1e-9);
  assert.ok(Math.abs(shares[4].share - 1000 / 96900) < 1e-9);
  // Percentages of used context sum to ~100%
  const sum = shares.reduce((n, s) => n + s.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.001);
});

test("category shares: empty/unmeasured categories yield nothing", () => {
  assert.deepEqual(categoryShares(null), []);
  assert.deepEqual(categoryShares({ totalUsed: 5, contextLimit: 10, categories: {} }), []);
  assert.deepEqual(categoryShares({ totalUsed: 5, contextLimit: 10, categories: { messages: 0 } }), []);
});

test("cache hit rate: normalized from rate OR raw tokens; null when unreported", () => {
  assert.equal(cacheHitRate({ rate: 0.967 }), 0.967);
  assert.equal(cacheHitRate({ cachedTokens: 967, promptTokens: 1000 }), 0.967);
  assert.equal(cacheHitRate({ cachedTokens: 1200, promptTokens: 1000 }), 1, "clamped to 1");
  assert.equal(cacheHitRate({ cachedTokens: 0, promptTokens: 1000 }), 0);
  assert.equal(cacheHitRate({ promptTokens: 1000 }), null, "no cached figure → hidden, never invented");
  assert.equal(cacheHitRate(null), null);
});

test("quota: only rendered when a real limit is configured", () => {
  assert.equal(quotaFromServer(null), null);
  assert.equal(quotaFromServer({ limit: 0, used: 3 }), null, "0 = unlimited → no fabricated quota");
  const q = quotaFromServer({ limit: 500, used: 140, remaining: 360, resetsAt: 1_791_000_000_000 });
  assert.ok(q);
  assert.equal(q.unit, "requests");
  assert.equal(q.remaining, 360);
  const qNoRemaining = quotaFromServer({ limit: 500, used: 140 });
  assert.equal(qNoRemaining?.remaining, 360, "derived remaining is honest arithmetic on real values");
});

test("token formatting: compact and stable", () => {
  assert.equal(formatTokens(980), "980");
  assert.equal(formatTokens(444_500), "444.5K");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(null), "—");
});
