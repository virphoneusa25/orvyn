import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreditLedger } from "./CreditLedger";
import { UsageService } from "../services/UsageService";
import { laneForUsage } from "./plans";

test("Kontext provider cost charges 120/260 credits, counts every image, rejects missing costs and replays", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-image-billing-"));
  const db = new CreditLedger(join(dir, "billing.sqlite"));
  try {
    db.setPlan("customer", "pro");
    assert.equal(db.charge({ userId: "customer", eventId: "pro", type: "image", lane: "image", imageCount: 2, providerCostUsd: .08 }).creditsCharged, 240);
    assert.equal(db.charge({ userId: "customer", eventId: "max", type: "image", lane: "image_pro", imageCount: 1, providerCostUsd: .08 }).creditsCharged, 260);
    assert.equal(db.charge({ userId: "customer", eventId: "max", type: "image", lane: "image_pro", providerCostUsd: .08 }).creditsCharged, 0);
    assert.throws(() => db.charge({ userId: "customer", type: "image" }), /exact provider cost/);
    assert.equal(db.charge({ userId: "customer", type: "image", ok: false, providerCostUsd: 0 }).creditsCharged, 0);
    assert.equal(laneForUsage({ method: "image", modelId: "fw:accounts/fireworks/models/flux-kontext-max" }), "image_pro");
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("parallel image preflights reserve allowance, failures release it and no tokens are needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-image-billing-"));
  const db = new CreditLedger(join(dir, "billing.sqlite"));
  const usage = new UsageService();
  try {
    db.setPlan("customer", "starter");
    // Starter has a small image window. A full-window outstanding request blocks another.
    const { PLANS } = await import("./plans");
    let releases: Array<() => void> = [];
    for (let n = 0; n < PLANS.starter.images5h; n++) releases.push(db.reserveImage("customer", 1, "image", .04));
    assert.throws(() => db.reserveImage("customer", 1, "image", .04), /image allowance/);
    const reopened = new CreditLedger(join(dir, "billing.sqlite"));
    try { assert.throws(() => reopened.reserveImage("customer", 1, "image", .04), /image allowance/); }
    finally { reopened.close(); }
    for (const release of releases) release();
    const release = db.reserveImage("customer", 1, "image", .04); release();
    db.ensureAccount("free-customer");
    assert.throws(() => db.reserveImage("free-customer", 1, "image_pro", .08), /Image generation|image allowance/);
    usage.onPreflight((_ctx, model) => model?.method === "image" ? db.reserveImage("customer", model.imageCount!, model.imageRate!.premium ? "image_pro" : "image", model.providerCostUsd!) : undefined);
    usage.onRecord((e) => db.charge({ userId: "customer", eventId: e.id, type: "image", lane: laneForUsage(e), imageCount: e.imageCount, providerCostUsd: e.providerCostUsd, ok: e.ok }));
    const config = { id: "fw:accounts/fireworks/models/flux-kontext-pro", provider: "openai-compatible" as const, providerName: "fireworks",
      imageRate: { usdPerImage: .04, premium: false, source: "fixture", verifiedAt: Date.now(), expiresAt: Date.now()+60_000 } };
    await assert.rejects(usage.imageCall(config, 1, async () => { throw new Error("provider unavailable"); }, () => 1));
    await usage.imageCall(config, 2, async () => ["image-one", "image-two"], (res) => res.length);
    const events = usage.recent();
    assert.equal(events[0].providerCostUsd, .08); assert.equal(events[0].imageCount, 2);
    assert.equal(events[0].provider, "fireworks"); assert.equal(events[0].promptTokens, undefined);
    assert.equal(events[1].ok, false);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
});
