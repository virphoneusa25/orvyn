import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createServer } from "node:http";
import { CreditLedger } from "./CreditLedger";
import { BillingService, StripeStore, signStripePayload, verifyStripeSignature, planForPrice } from "./stripe";

const SECRET = "whsec_test_secret";
const env = {
  STRIPE_PRICE_PRO_MONTHLY: "price_pro_m",
  STRIPE_PRICE_PRO_YEARLY: "price_pro_y",
  STRIPE_PRICE_STARTER_MONTHLY: "price_starter_m",
  STRIPE_PRICE_PACK_10K: "price_pack10k",
} as NodeJS.ProcessEnv;

function setup(apiBase = "http://127.0.0.1:9") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-stripe-"));
  const ledger = new CreditLedger(path.join(dir, "billing.sqlite"));
  const store = new StripeStore(path.join(dir, "payments.sqlite"));
  const svc = new BillingService({ secretKey: "sk_test_x", webhookSecret: SECRET, apiBase, publicOrigin: "https://app.example" }, store, ledger, {}, env);
  return { ledger, store, svc };
}

function deliver(svc: BillingService, event: object, secret = SECRET) {
  const body = JSON.stringify(event);
  return svc.handleWebhook(Buffer.from(body), signStripePayload(body, secret));
}

test("signatures: valid passes; tampered, wrong secret and stale are refused", () => {
  const body = '{"id":"evt_1"}';
  const now = Math.floor(Date.now() / 1000);
  assert.equal(verifyStripeSignature(body, signStripePayload(body, SECRET, now), SECRET, now), true);
  assert.equal(verifyStripeSignature(body + " ", signStripePayload(body, SECRET, now), SECRET, now), false);
  assert.equal(verifyStripeSignature(body, signStripePayload(body, "whsec_other", now), SECRET, now), false);
  assert.equal(verifyStripeSignature(body, signStripePayload(body, SECRET, now - 3600), SECRET, now), false);
  assert.equal(verifyStripeSignature(body, undefined, SECRET, now), false);
});

test("an unsigned or forged webhook changes nothing", async () => {
  const { ledger, svc } = setup();
  ledger.ensureAccount("acct_a");
  const forged = { id: "evt_forged", type: "invoice.paid", data: { object: { subscription: "sub_x", metadata: { accountId: "acct_a" }, lines: { data: [{ price: { id: "price_pro_m" }, period: { start: 1, end: 2 } }] } } } };
  const r = await deliver(svc, forged, "whsec_attacker");
  assert.equal(r.status, 400);
  assert.equal(ledger.planOf("acct_a"), "free");
  assert.equal(ledger.snapshot("acct_a").includedBalance, 2_000);
});

test("a paid top-up credits once, however often Stripe delivers it", async () => {
  const { ledger, svc } = setup();
  ledger.ensureAccount("acct_a");
  const evt = { id: "evt_topup_1", type: "checkout.session.completed", data: { object: { id: "cs_1", mode: "payment", payment_status: "paid", payment_intent: "pi_1", amount_total: 1000, customer: "cus_1", metadata: { accountId: "acct_a", kind: "topup", packId: "pack_10k" } } } };
  assert.equal((await deliver(svc, evt)).status, 200);
  const replay = await deliver(svc, evt);
  assert.equal(replay.body.duplicate, true);
  // A different event about the same payment (e.g. async_payment_succeeded) cannot credit again either.
  await deliver(svc, { ...evt, id: "evt_topup_2", type: "checkout.session.async_payment_succeeded" });
  assert.equal(ledger.snapshot("acct_a").purchasedBalance, 10_000);
});

test("an unpaid checkout (async method pending) credits nothing yet", async () => {
  const { ledger, svc } = setup();
  ledger.ensureAccount("acct_a");
  await deliver(svc, { id: "evt_p", type: "checkout.session.completed", data: { object: { id: "cs_2", mode: "payment", payment_status: "unpaid", payment_intent: "pi_2", metadata: { accountId: "acct_a", kind: "topup", packId: "pack_10k" } } } });
  assert.equal(ledger.snapshot("acct_a").purchasedBalance, 0);
});

test("subscription: paid invoice grants the plan once per period; renewal grants again; cancellation returns to Free", async () => {
  const { ledger, svc, store } = setup();
  ledger.ensureAccount("acct_b");
  store.saveCustomer("acct_b", "cus_b", null);
  const t0 = Math.floor(Date.UTC(2026, 9, 1) / 1000);
  const invoice = (id: string, start: number) => ({ id, type: "invoice.paid", data: { object: { id: `in_${id}`, customer: "cus_b", subscription: "sub_b", amount_paid: 5900, lines: { data: [{ price: { id: "price_pro_m" }, period: { start, end: start + 30 * 86400 } }] } } } });
  await deliver(svc, invoice("evt_inv_1", t0));
  await deliver(svc, invoice("evt_inv_1", t0)); // replay
  await deliver(svc, { ...invoice("evt_inv_1b", t0) }); // a second event for the same period
  assert.equal(ledger.planOf("acct_b"), "pro");
  assert.equal(ledger.grantsIssued("acct_b").filter((g) => g.plan === "pro").length, 1);
  assert.equal(ledger.snapshot("acct_b").includedBalance, 60_000);
  await deliver(svc, invoice("evt_inv_2", t0 + 30 * 86400));
  assert.equal(ledger.grantsIssued("acct_b").filter((g) => g.plan === "pro").length, 2);
  await deliver(svc, { id: "evt_fail", type: "invoice.payment_failed", data: { object: { customer: "cus_b", amount_due: 5900 } } });
  assert.equal(ledger.subscriptionOf("acct_b")?.status, "past_due");
  await deliver(svc, { id: "evt_del", type: "customer.subscription.deleted", data: { object: { id: "sub_b", customer: "cus_b", metadata: {} } } });
  assert.equal(ledger.planOf("acct_b"), "free");
  assert.ok(ledger.verify("acct_b").ok);
});

test("subscription.updated never grants credits", async () => {
  const { ledger, svc, store } = setup();
  ledger.ensureAccount("acct_c");
  store.saveCustomer("acct_c", "cus_c", null);
  await deliver(svc, { id: "evt_upd", type: "customer.subscription.updated", data: { object: { id: "sub_c", customer: "cus_c", status: "active", items: { data: [{ price: { id: "price_pro_m" } }] } } } });
  assert.equal(ledger.planOf("acct_c"), "free");
  assert.equal(ledger.snapshot("acct_c").includedBalance, 2_000);
});

test("a refund removes what the payment bought", async () => {
  const { ledger, svc } = setup();
  ledger.ensureAccount("acct_d");
  await deliver(svc, { id: "evt_buy", type: "checkout.session.completed", data: { object: { id: "cs_d", mode: "payment", payment_status: "paid", payment_intent: "pi_d", metadata: { accountId: "acct_d", kind: "topup", packId: "pack_10k" } } } });
  await deliver(svc, { id: "evt_ref", type: "charge.refunded", data: { object: { id: "ch_d", payment_intent: "pi_d", amount: 1000, amount_refunded: 1000 } } });
  await deliver(svc, { id: "evt_ref", type: "charge.refunded", data: { object: { id: "ch_d", payment_intent: "pi_d", amount: 1000, amount_refunded: 1000 } } });
  assert.equal(ledger.snapshot("acct_d").purchasedBalance, 0);
});

test("checkout uses configured prices only and never creates products", async () => {
  const calls: { path: string; body: string }[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ path: req.url ?? "", body });
      res.setHeader("Content-Type", "application/json");
      if (req.url?.startsWith("/v1/customers")) return res.end(JSON.stringify({ id: "cus_new" }));
      if (req.url?.startsWith("/v1/checkout/sessions")) return res.end(JSON.stringify({ id: "cs_new", url: "https://checkout.stripe.test/cs_new" }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as any).port;
  const { svc, store } = setup(`http://127.0.0.1:${port}`);
  const out = await svc.checkout({ accountId: "acct_e", email: "e@example.com", planId: "pro", period: "yearly" });
  assert.equal(out.url, "https://checkout.stripe.test/cs_new");
  const session = calls.find((c) => c.path === "/v1/checkout/sessions")!;
  assert.match(decodeURIComponent(session.body), /line_items\[0\]\[price\]=price_pro_y/);
  assert.match(decodeURIComponent(session.body), /mode=subscription/);
  assert.ok(!calls.some((c) => /\/v1\/(products|prices)/.test(c.path)), "no products or prices created");
  assert.equal(store.customerOf("acct_e"), "cus_new");
  await assert.rejects(svc.checkout({ accountId: "acct_e", email: "e@example.com", planId: "power", period: "monthly" }), /isn't available/);
  await assert.rejects(svc.checkout({ accountId: "acct_e", email: "e@example.com", planId: "free" }), /can't be bought/);
  await assert.rejects(svc.checkout({ accountId: "acct_e", email: "e@example.com", planId: "enterprise" }), /can't be bought/);
  server.close();
});

test("price ids map back to plans", () => {
  assert.equal(planForPrice("price_pro_y", env), "pro");
  assert.equal(planForPrice("price_unknown", env), null);
});
