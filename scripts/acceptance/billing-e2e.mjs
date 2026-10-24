// scripts/acceptance/billing-e2e.mjs
//
// Billing over the real HTTP API (ORVYN Cloud mode, a mock Stripe API, a
// scripted model):
//   1. The old free-grant endpoints are gone (410); nothing changes the plan
//      or balance except a verified Stripe webhook.
//   2. Checkout returns Stripe's hosted URL, built from configured price ids.
//      Returning from the browser changes nothing.
//   3. A signed checkout.session.completed credits the pack once; a replay,
//      a forged signature, or a second event for the same payment do not.
//   4. A paid invoice puts the account on Pro once per period.
//   5. Runs spend through the ledger (reserve → settle → release) and the
//      pre-call gate refuses the next run once the rolling window is used.
//   6. The ledger's history is intact (the balance equals the sum of entries).
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/billing-e2e.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 4841, MODEL_PORT = 4842, STRIPE_PORT = 4843;
const BASE = `http://127.0.0.1:${PORT}`;
const WHSEC = "whsec_e2e_test";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-bill-data-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

// ---- scripted model: "BIG" instructions report a large usage ----
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const big = (body.messages ?? []).some((m) => m.role === "user" && /BIG/.test(textOf(m.content)));
    const usage = big ? { prompt_tokens: 3_000_000, completion_tokens: 10, total_tokens: 3_000_010 } : { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 };
    const text = "Done.";
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

// ---- mock Stripe API ----
const stripeCalls = [];
const stripe = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    stripeCalls.push({ method: req.method, url: req.url, body: decodeURIComponent(raw), auth: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/v1/customers")) return res.end(JSON.stringify({ id: "cus_e2e" }));
    if (req.url?.startsWith("/v1/checkout/sessions")) return res.end(JSON.stringify({ id: `cs_e2e_${stripeCalls.length}`, url: "https://checkout.stripe.test/pay" }));
    if (req.url?.startsWith("/v1/billing_portal/sessions")) return res.end(JSON.stringify({ url: "https://billing.stripe.test/portal" }));
    res.statusCode = 404; res.end("{}");
  });
});

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
const webhook = async (event, secret = WHSEC) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
  const r = await fetch(`${BASE}/api/v1/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const wallet = async (token) => (await call("/billing", "GET", null, token)).json.wallet;
async function runTask(token, instruction) {
  const started = await call("/chat/completions", "POST", { message: instruction, composerMode: "ask", context: { mode: "ask" } }, token);
  return { started, status: started.status === 200 && started.json.content ? "completed" : "failed" };
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => stripe.listen(STRIPE_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-bill-proj-")), PORT: String(PORT),
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_PUBLIC_ORIGIN: BASE,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    STRIPE_SECRET_KEY: "sk_test_e2e", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_m", STRIPE_PRICE_PACK_10K: "price_pack10k",
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted", OPENAI_CODE_MODEL: "scripted",
    ORVYN_PROVIDER_RATES_JSON: JSON.stringify([{ provider: "openai-compatible", modelId: "scripted", input: .2, cachedInput: .02, output: .8, source: "https://fixture.invalid/pricing", verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 }]),
  };
  delete env.ORVYN_API_KEY;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    const legal = await call("/auth/legal", "GET");
    const reg = await call("/auth/register", "POST", { name: "Payer", email: "payer@example.com", password: "a-long-password-1", legalAccepted: true, legalVersion: legal.json.version });
    const T = reg.json.token;
    const acct = reg.json.principal?.tenantId;
    await call("/onboarding/provision", "POST", {}, T);
    await call("/onboarding", "PUT", { step: "complete", completed: ["first_mission"] }, T);
    const w0 = await wallet(T);
    ok(w0?.plan?.id === "free" && w0?.availableBalance === 2000, "a new account is on Free with 2,000 credits", JSON.stringify(w0));

    console.log("\n1. No free grants");
    const plan = await call("/billing/plan", "POST", { planId: "pro" }, T);
    const topup = await call("/billing/topup", "POST", { packId: "pack_10k" }, T);
    ok(plan.status === 410 && topup.status === 410, "the old plan/top-up endpoints refuse (410)", `${plan.status} ${topup.status}`);
    ok((await wallet(T)).plan.id === "free" && (await wallet(T)).availableBalance === 2000, "…and nothing changed");

    console.log("\n2. Checkout");
    const co = await call("/billing/checkout", "POST", { packId: "pack_10k" }, T);
    ok(co.status === 200 && co.json.url === "https://checkout.stripe.test/pay", "checkout returns Stripe's hosted page", `${co.status} ${co.text.slice(0, 200)}`);
    const sess = stripeCalls.find((c) => c.url === "/v1/checkout/sessions");
    ok(/line_items\[0\]\[price\]=price_pack10k/.test(sess?.body ?? "") && /metadata\[accountId\]=/.test(sess?.body ?? ""), "…built from the configured price, tagged with the account", sess?.body?.slice(0, 300));
    ok(!stripeCalls.some((c) => /\/v1\/(products|prices)/.test(c.url)), "no Stripe products or prices are created");
    const unavailable = await call("/billing/checkout", "POST", { planId: "power", period: "monthly" }, T);
    ok(unavailable.status === 503, "a plan without a configured price is not sold", `${unavailable.status}`);
    const back = await fetch(`${BASE}/api/v1/billing/return?status=success&session_id=cs_whatever`);
    ok(back.status === 200 && /being confirmed|as soon as the payment is confirmed/.test(await back.text()), "returning from Checkout shows 'confirming'…");
    ok((await wallet(T)).purchasedBalance === 0, "…and grants nothing");

    console.log("\n3. Webhook: verified, idempotent");
    const paid = { id: "evt_e2e_1", type: "checkout.session.completed", data: { object: { id: "cs_e2e_x", mode: "payment", payment_status: "paid", payment_intent: "pi_e2e_1", amount_total: 1000, customer: "cus_e2e", metadata: { accountId: acct, kind: "topup", packId: "pack_10k" } } } };
    const forged = await webhook({ ...paid, id: "evt_forged" }, "whsec_attacker");
    ok(forged.status === 400 && (await wallet(T)).purchasedBalance === 0, "a forged signature is refused and changes nothing", `${forged.status}`);
    const first = await webhook(paid);
    ok(first.status === 200 && (await wallet(T)).purchasedBalance === 10_000, "a signed payment credits the pack", `${first.status} ${JSON.stringify(first.json)}`);
    const replay = await webhook(paid);
    const again = await webhook({ ...paid, id: "evt_e2e_1b", type: "checkout.session.async_payment_succeeded" });
    ok(replay.json.duplicate === true && again.status === 200 && (await wallet(T)).purchasedBalance === 10_000, "a replay or a second event for the same payment credits nothing more");
    const t0 = Math.floor(Date.now() / 1000);
    const invoice = { id: "evt_inv", type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_e2e", subscription: "sub_e2e", amount_paid: 5900, subscription_details: { metadata: { accountId: acct, planId: "pro" } }, lines: { data: [{ price: { id: "price_pro_m" }, period: { start: t0, end: t0 + 30 * 86400 } }] } } } };
    await webhook(invoice); await webhook(invoice); await webhook({ ...invoice, id: "evt_inv_dup" });
    const wPro = await wallet(T);
    ok(wPro.plan.id === "pro" && wPro.includedBalance === 60_000, "a paid invoice puts the account on Pro with 60,000 credits, once", JSON.stringify({ plan: wPro.plan, inc: wPro.includedBalance }));
    const portal = await call("/billing/portal", "POST", {}, T);
    ok(portal.json.url === "https://billing.stripe.test/portal", "Manage billing opens Stripe's portal");

    console.log("\n4. Runs spend through the ledger and the gate holds");
    // A second, Free account for the window test.
    const reg2 = await call("/auth/register", "POST", { name: "Free", email: "free@example.com", password: "a-long-password-2", legalAccepted: true, legalVersion: legal.json.version });
    const F = reg2.json.token;
    await call("/onboarding/provision", "POST", {}, F);
    await call("/onboarding", "PUT", { step: "complete", completed: ["first_mission"] }, F);
    const small = await runTask(F, "Say hello");
    const wSmall = await wallet(F);
    ok(small.status === "completed" && wSmall.availableBalance < 2000 && wSmall.reservedBalance === 0, "a run is charged and its hold is released", `${small.status} ${JSON.stringify({ a: wSmall.availableBalance, r: wSmall.reservedBalance })}`);
    const big = await runTask(F, "BIG job please");
    const wBig = await wallet(F);
    ok(wBig.windows.fiveHour.used >= wBig.windows.fiveHour.limit, "a large run uses up the 5-hour window", JSON.stringify(wBig.windows.fiveHour) + ` ${big.status}`);
    const refused = await call("/chat/completions", "POST", { message: "one more", composerMode: "ask", context: { mode: "ask" } }, F);
    ok(refused.status === 402 && refused.json.code === "CREDITS_WINDOW_5H" && /5-hour/.test(refused.json.error), "the next run is refused in plain words (402)", `${refused.status} ${JSON.stringify(refused.json)}`);
    ok(wBig.availableBalance >= 0 && wBig.reservedBalance === 0, "the balance never goes below zero and nothing stays held", JSON.stringify({ a: wBig.availableBalance, r: wBig.reservedBalance }));

    console.log("\n5. The ledger is the record");
    const db = new DatabaseSync(join(dataDir, "billing.sqlite"));
    const sums = db.prepare(`SELECT account_id, bucket, SUM(amount) AS n FROM ledger_entries GROUP BY account_id, bucket`).all();
    const types = new Set(db.prepare(`SELECT DISTINCT type FROM ledger_entries`).all().map((r) => r.type));
    let immutable = false; try { db.prepare(`UPDATE ledger_entries SET amount = 1`).run(); } catch { immutable = true; }
    db.close();
    ok(sums.every((s) => s.n >= 0), "no balance bucket is negative", JSON.stringify(sums));
    ok(["monthly_grant", "topup_purchase", "usage_settlement", "expiration"].every((t) => types.has(t)), "grants, top-ups, model settlements and expirations are all entries", [...types].join(","));
    ok(immutable, "ledger entries cannot be edited");
    ok(!log.join("").includes("sk_test_e2e") && !log.join("").includes(WHSEC), "no Stripe secret in the server log");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close(); stripe.close();
  }
  if (failures) console.log("--- server log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nBILLING E2E: PASS" : `\nBILLING E2E: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
main();
