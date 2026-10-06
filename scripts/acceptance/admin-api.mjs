// scripts/acceptance/admin-api.mjs
//
// ORVYN Admin Portal API against the real backend (mock Stripe, scripted model,
// email captured to files):
//   1. RBAC: customers (even org owners) get 403 on /admin; staff roles are
//      enforced per action (support can't move credits; billing can't pause).
//   2. Dashboard and customer list are computed from real data; search, filters
//      and pagination work.
//   3. Adjust credits: +5,000 → one immutable ledger entry with reason + admin,
//      the wallet moves, an audit row is written, the customer sees it; a
//      replayed request writes nothing; a debit can't go below zero.
//   4. Pause: the customer's API and chat socket are refused, data untouched,
//      subscription unchanged; reactivate restores access. Both audited.
//   5. Password reset / resend verification send real emails (captured).
//   6. Support note (internal), profile edit, activity, audit.
//   7. Plan management goes through Stripe (change, schedule, cancel at renewal,
//      resume); complimentary plan is super-admin only.
//   8. View as customer: read-only, audited, ends on logout.
//   9. Isolation: customer A can't read customer B; provider costs are
//      admin-only and hidden from roles without cost access.
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/admin-api.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 4881, MODEL_PORT = 4882, STRIPE_PORT = 4883;
const BASE = `http://127.0.0.1:${PORT}`;
const WHSEC = "whsec_admin_test";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-admin-data-"));
const mailDir = mkdtempSync(join(tmpdir(), "orvyn-admin-mail-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "x" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const usage = { prompt_tokens: 4000, completion_tokens: 800, total_tokens: 4800 };
    const text = "Answer.";
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

const stripeCalls = [];
const now = Math.floor(Date.now() / 1000);
const stripe = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const body = decodeURIComponent(raw);
    stripeCalls.push({ method: req.method, url: req.url, body });
    res.setHeader("Content-Type", "application/json");
    const u = req.url ?? "";
    if (u.startsWith("/v1/customers")) return res.end(JSON.stringify({ id: "cus_admin" }));
    if (u.startsWith("/v1/checkout/sessions")) return res.end(JSON.stringify({ id: `cs_admin_${stripeCalls.length}`, url: "https://checkout.stripe.test/pay" }));
    if (u.startsWith("/v1/subscription_schedules")) return res.end(JSON.stringify({ id: "sub_sched_1" }));
    if (u.startsWith("/v1/subscriptions/sub_admin")) return res.end(JSON.stringify({ id: "sub_admin", status: "active", cancel_at_period_end: /cancel_at_period_end=true/.test(body), items: { data: [{ id: "si_1", price: { id: "price_pro_m", recurring: { interval: "month" } }, current_period_start: now, current_period_end: now + 30 * 86400 }] } }));
    if (u.startsWith("/v1/invoices")) return res.end(JSON.stringify({ data: [{ id: "in_admin_1", number: "INV-0001", customer: "cus_admin", created: now - 60, status: "paid", amount_paid: 5900, lines: { data: [{ description: "ORVYN Pro" }] }, hosted_invoice_url: "https://invoice.stripe.test/1", invoice_pdf: null }], has_more: false }));
    if (u.startsWith("/v1/payment_methods")) return res.end(JSON.stringify({ data: [{ card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 } }] }));
    if (u.startsWith("/v1/subscriptions")) return res.end(JSON.stringify({ data: [] }));
    res.statusCode = 404; res.end("{}");
  });
});

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
const webhook = async (event) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
  return fetch(`${BASE}/api/v1/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body });
};
async function account(email, name) {
  const reg = await call("/auth/register", "POST", { name, email, password: "a-long-password-1" });
  const T = reg.json.token;
  await call("/onboarding/provision", "POST", {}, T);
  await call("/onboarding", "PUT", { step: "complete" }, T);
  return { token: T, tenantId: reg.json.principal?.tenantId, userId: reg.json.user?.id };
}
function socketTurn(token) {
  return new Promise(async (done) => {
    const { json } = await call("/auth/ws-ticket", "POST", {}, token);
    if (!json.ticket) return done({ refused: true, error: "no ticket" });
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?ticket=${encodeURIComponent(json.ticket)}`);
    const t = setTimeout(() => { try { ws.close(); } catch {} done({ error: "timeout" }); }, 10000);
    ws.onmessage = (ev) => {
      const c = JSON.parse(String(ev.data));
      if (c.type === "connection.ready") return ws.send(JSON.stringify({ task: "chat", surface: "cloud", userMessage: "hi", requestedModelId: "auto" }));
      if (c.error || c.done) { clearTimeout(t); ws.close(); done({ error: c.error ?? null, code: c.code ?? null }); }
    };
    ws.onclose = (e) => { clearTimeout(t); done({ refused: true, error: e.reason || `closed ${e.code}` }); };
  });
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => stripe.listen(STRIPE_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-admin-proj-")), PORT: String(PORT),
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_MAIL_CAPTURE: mailDir, ORVYN_PUBLIC_ORIGIN: BASE,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 6).toString("base64"), ORVYN_SUPER_ADMIN_EMAILS: "boss@orvyn.test",
    ORVYN_AUTH_RATE_LIMIT_RPM: "1000", ORVYN_AUTH_SESSION_RATE_LIMIT_RPM: "5000",
    STRIPE_SECRET_KEY: "sk_test_admin", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_m", STRIPE_PRICE_POWER_MONTHLY: "price_power_m", STRIPE_PRICE_POWER_ANNUAL: "price_power_y", STRIPE_PRICE_STARTER_MONTHLY: "price_starter_m", STRIPE_PRICE_PACK_10K: "price_pack10k",
    MODEL_API_KEY: "k", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "nebius:zai-org/GLM-5.3-Flash", OPENAI_CODE_MODEL: "nebius:zai-org/GLM-5.3-Flash",
    ORVYN_PROVIDER_RATES_JSON: JSON.stringify([{ provider: "openai-compatible", modelId: "nebius:zai-org/GLM-5.3-Flash", input: .2, cachedInput: .02, output: .8, source: "https://fixture.invalid/pricing", verifiedAt: Date.now() - 1000, expiresAt: Date.now() + 3_600_000 }]),
  };
  delete env.ORVYN_API_KEY; delete env.NODE_ENV;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    const boss = await account("boss@orvyn.test", "Boss Admin");
    const alice = await account("alice@acme.test", "Alice Owner");
    const bob = await account("bob@other.test", "Bob Other");
    const A = alice.tenantId;

    console.log("\n1. RBAC");
    const meBoss = await call("/auth/me", "GET", null, boss.token);
    ok(meBoss.json.staff?.role === "super_admin", "ORVYN_SUPER_ADMIN_EMAILS makes that account a super admin", JSON.stringify(meBoss.json.staff));
    const denied = await Promise.all(["/admin/dashboard", "/admin/customers", `/admin/customers/${A}`, "/admin/provider-costs", "/admin/audit"].map((p) => call(p, "GET", null, alice.token)));
    ok(denied.every((r) => r.status === 403 && r.json.code === "ADMIN_ONLY"), "a customer (their org's owner) gets 403 on every admin route", denied.map((r) => r.status).join(","));
    ok((await call("/admin/customers/" + A + "/credits/adjust", "POST", { credits: 99999, reason: "x", requestId: "r" }, alice.token)).status === 403, "…including admin actions");
    ok((await call("/admin/dashboard")).status === 401, "no session: 401");
    ok((await call("/auth/me", "GET", null, alice.token)).json.staff === null, "/auth/me says a customer is not staff");
    // A support-role staff member.
    const sup = await account("support@orvyn.test", "Sam Support");
    const setSup = await call("/admin/staff", "POST", { email: "support@orvyn.test", role: "support" }, boss.token);
    ok(setSup.status === 200 && setSup.json.member?.role === "support", "a super admin adds a support staff member", setSup.text.slice(0, 200));
    const supAdjust = await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: 100, reason: "try", requestId: randomUUID() }, sup.token);
    ok(supAdjust.status === 403, "support can't move credits (403)", `${supAdjust.status}`);
    ok((await call("/admin/provider-costs", "GET", null, sup.token)).status === 403 && (await call("/admin/dashboard", "GET", null, sup.token)).json.providerCosts === null, "support can't see internal provider costs");
    ok((await call("/admin/staff", "POST", { email: "alice@acme.test", role: "super_admin" }, sup.token)).status === 403, "support can't make anyone staff");

    console.log("\n2. Dashboard and customers");
    // Some real activity: a paid Pro subscription for Alice, usage for Bob.
    await webhook({ id: "evt_a1", type: "checkout.session.completed", data: { object: { id: "cs_a1", mode: "subscription", customer: "cus_admin", subscription: "sub_admin", payment_status: "paid", metadata: { accountId: A, kind: "subscription", planId: "pro", period: "monthly" } } } });
    await webhook({ id: "evt_a2", type: "invoice.paid", data: { object: { id: "in_admin_1", customer: "cus_admin", subscription: "sub_admin", amount_paid: 5900, subscription_details: { metadata: { accountId: A, planId: "pro" } }, lines: { data: [{ price: { id: "price_pro_m" }, period: { start: now, end: now + 30 * 86400 } }] } } } });
    const answered = await call("/chat/completions", "POST", { message: "Say hello", composerMode: "ask", context: { mode: "ask" } }, bob.token);
    ok(answered.status === 200 && Boolean(answered.json.content), "scripted chat records real usage", `${answered.status} ${JSON.stringify(answered.json)}`);
    const dash = await call("/admin/dashboard", "GET", null, boss.token);
    ok(dash.status === 200 && dash.json.totalUsers.value === 4 && dash.json.paidCustomers.value === 1 && dash.json.mrr.value === 59, "dashboard: 4 users, 1 paid customer, MRR $59 (from the real subscription)", JSON.stringify({ u: dash.json.totalUsers, p: dash.json.paidCustomers, m: dash.json.mrr }));
    ok(dash.json.revenueByPlan?.[0]?.plan === "pro" && dash.json.subscriptions.active === 1 && dash.json.creditsUsed.value > 0 && dash.json.creditTrend.length === 30 && dash.json.signups.days.length === 30, "…revenue by plan, subscription status, credits used, 30-day trends", JSON.stringify({ r: dash.json.revenueByPlan, s: dash.json.subscriptions, c: dash.json.creditsUsed }));
    ok(dash.json.providerCosts?.totalUsd >= 0 && Array.isArray(dash.json.activity), "…internal provider costs and recent activity");
    const list = await call("/admin/customers?pageSize=2", "GET", null, boss.token);
    ok(list.json.total === 4 && list.json.customers.length === 2 && list.json.counts.paid === 1, "customers are paged (2 of 4) with filter counts", JSON.stringify({ t: list.json.total, n: list.json.customers?.length, c: list.json.counts }));
    const page2 = await call("/admin/customers?pageSize=2&page=2", "GET", null, boss.token);
    ok(page2.json.customers.length === 2 && !page2.json.customers.some((c) => list.json.customers.some((d) => d.id === c.id)), "page 2 holds the other two");
    const found = await call("/admin/customers?q=alice", "GET", null, boss.token);
    ok(found.json.total === 1 && found.json.customers[0].id === A && found.json.customers[0].plan.id === "pro" && found.json.customers[0].contact.email === "alice@acme.test", "search by contact email finds Alice on Pro", JSON.stringify(found.json.customers?.[0]));
    const paid = await call("/admin/customers?filter=paid", "GET", null, boss.token);
    ok(paid.json.total === 1 && paid.json.customers[0].id === A, "the Paid filter holds only Alice");
    const gs = await call("/admin/search?q=sub_admin", "GET", null, boss.token);
    ok(gs.json.subscriptions?.[0]?.tenantId === A, "global search finds the subscription", JSON.stringify(gs.json));
    const gi = await call("/admin/search?q=in_admin_1", "GET", null, boss.token);
    ok(gi.json.invoices?.[0]?.id === "in_admin_1", "…and an invoice by id (from Stripe)", JSON.stringify(gi.json.invoices));
    const detail = await call(`/admin/customers/${A}`, "GET", null, boss.token);
    const c = detail.json.customer;
    ok(c?.stripe?.customerId === "cus_admin" && c?.stripe?.subscriptionId === "sub_admin" && c?.wallet?.included === 60000 && c?.team?.[0]?.email === "alice@acme.test", "customer detail: Stripe ids, wallet, members", JSON.stringify({ s: c?.stripe, w: c?.wallet?.included }));
    const inv = await call(`/admin/customers/${A}/invoices`, "GET", null, boss.token);
    ok(inv.json.invoices?.[0]?.id === "in_admin_1" && inv.json.invoices[0].amountUsd === 59, "invoices come from Stripe");
    const sub = await call(`/admin/customers/${A}/subscription`, "GET", null, boss.token);
    ok(sub.json.subscription?.id === "sub_admin" && sub.json.subscription?.planId === "pro" && sub.json.subscription?.status === "active", "the subscription is read live from Stripe", JSON.stringify(sub.json.subscription));

    console.log("\n3. Adjust credits (ledger, never an overwrite)");
    const before = (await call("/billing", "GET", null, alice.token)).json.wallet;
    const reqId = randomUUID();
    const grant = await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: 5000, reason: "Launch promo", category: "promotional", requestId: reqId }, boss.token);
    ok(grant.status === 200 && grant.json.entries?.[0]?.amount === 5000 && grant.json.entries[0].actor === "staff:boss@orvyn.test", "the grant is one ledger entry attributed to the admin", grant.text.slice(0, 300));
    const afterW = (await call("/billing", "GET", null, alice.token)).json.wallet;
    ok(afterW.availableBalance === before.availableBalance + 5000 && afterW.purchasedBalance === before.purchasedBalance + 5000, "the customer's own balance shows +5,000", `${before.availableBalance} → ${afterW.availableBalance}`);
    const replay = await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: 5000, reason: "Launch promo", category: "promotional", requestId: reqId }, boss.token);
    ok(replay.status === 200 && (await call("/billing", "GET", null, alice.token)).json.wallet.availableBalance === afterW.availableBalance, "a replayed request (double click) grants nothing more");
    const db = new DatabaseSync(join(dataDir, "billing.sqlite"));
    const rows = db.prepare(`SELECT * FROM ledger_entries WHERE account_id = ? AND type = 'admin_adjustment'`).all(A);
    let immutable = false; try { db.prepare(`UPDATE ledger_entries SET amount = 1 WHERE account_id = ?`).run(A); } catch { immutable = true; }
    db.close();
    ok(rows.length === 1 && JSON.parse(rows[0].meta).reason === "Launch promo" && JSON.parse(rows[0].meta).category === "promotional" && rows[0].actor === "staff:boss@orvyn.test" && rows[0].created_at > 0 && immutable, "the ledger holds exactly one entry (amount, reason, admin, time) and refuses edits", JSON.stringify(rows));
    const aud = await call(`/admin/customers/${A}/audit`, "GET", null, boss.token);
    ok(aud.json.audit?.some((a) => a.action === "credits.adjust" && a.actorEmail === "boss@orvyn.test" && a.detail.credits === 5000) && aud.json.audit.filter((a) => a.action === "credits.adjust").length === 1, "one audit row for the adjustment", JSON.stringify(aud.json.audit?.map((a) => a.action)));
    const tooMuch = await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: -10_000_000, reason: "oops", requestId: randomUUID() }, boss.token);
    ok(tooMuch.status === 400 && /available/.test(tooMuch.json.error), "a debit larger than the balance is refused", tooMuch.text.slice(0, 200));
    const debit = await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: -6000, reason: "Billing correction", category: "billing_correction", requestId: randomUUID() }, boss.token);
    const wD = (await call("/billing", "GET", null, alice.token)).json.wallet;
    ok(debit.status === 200 && debit.json.entries.length === 2 && wD.purchasedBalance === 0 && wD.availableBalance === afterW.availableBalance - 6000, "a debit takes top-up credits first, then included — as two ledger entries", JSON.stringify({ e: debit.json.entries?.map((e) => [e.bucket, e.amount]), w: wD }));
    ok((await call(`/admin/customers/${A}/credits/adjust`, "POST", { credits: 10, reason: "", requestId: randomUUID() }, boss.token)).status === 400, "a reason is required");

    console.log("\n4. Pause and reactivate");
    const projBefore = (await call("/projects", "POST", { name: "Keep me" }, alice.token)).json.project;
    ok((await call(`/admin/customers/${A}/suspend`, "POST", { reason: "Chargeback review", category: "billing" }, boss.token)).status === 400, "pausing needs explicit confirmation");
    const pause = await call(`/admin/customers/${A}/suspend`, "POST", { reason: "Chargeback review", category: "billing", confirm: true }, boss.token);
    ok(pause.status === 200 && pause.json.suspension?.category === "billing", "a super admin pauses the account", pause.text.slice(0, 200));
    const blocked = await Promise.all([call("/projects", "GET", null, alice.token), call("/sessions", "GET", null, alice.token), call("/billing", "GET", null, alice.token)]);
    ok(blocked.every((r) => r.status === 403 && r.json.code === "ACCOUNT_PAUSED"), "the customer's API answers 403 ACCOUNT_PAUSED", blocked.map((r) => `${r.status}:${r.json.code}`).join(","));
    const turn = await socketTurn(alice.token);
    ok(Boolean(turn.refused || turn.code === "ACCOUNT_PAUSED" || /paused/i.test(turn.error ?? "")), "…and so does the chat socket", JSON.stringify(turn));
    const me = await call("/auth/me", "GET", null, alice.token);
    ok(me.status === 200 && me.json.paused?.since > 0, "sign-in still works and /auth/me says the account is paused (the portal shows why)");
    ok((await call("/sessions", "GET", null, bob.token)).status === 200, "other customers are unaffected");
    const dPaused = (await call(`/admin/customers/${A}`, "GET", null, boss.token)).json.customer;
    ok(dPaused.status === "paused" && dPaused.plan.id === "pro" && dPaused.stripe.subscriptionId === "sub_admin" && dPaused.wallet.available === wD.availableBalance, "data, plan and subscription are unchanged while paused");
    ok((await call("/admin/customers?filter=paused", "GET", null, boss.token)).json.customers?.[0]?.id === A, "the Paused filter lists it");
    const re = await call(`/admin/customers/${A}/reactivate`, "POST", { reason: "Resolved" }, boss.token);
    ok(re.status === 200 && (await call("/projects", "GET", null, alice.token)).json.projects?.some((p) => p.id === projBefore.id), "reactivate restores access with the data intact");
    const acts = (await call(`/admin/customers/${A}/audit`, "GET", null, boss.token)).json.audit.map((a) => a.action);
    ok(acts.includes("account.suspend") && acts.includes("account.reactivate"), "both are audited");

    console.log("\n5. Emails");
    const reset = await call(`/admin/customers/${A}/password-reset`, "POST", {}, boss.token);
    const verify = await call(`/admin/customers/${bob.tenantId}/resend-verification`, "POST", {}, sup.token);
    await sleep(200);
    const mails = readdirSync(mailDir).map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf8")));
    ok(reset.status === 200 && mails.some((m) => m.to === "alice@acme.test" && /reset/i.test(m.subject) && /\/api\/v1\/auth\/reset\?token=/.test(m.text)), "Send password reset emails a real single-use link (no password is shown to staff)", reset.text);
    ok(!/token|password/i.test(JSON.stringify(reset.json).replace(/"to"/, "")), "…and the admin response carries no token");
    ok(verify.status === 200 && mails.some((m) => m.to === "bob@other.test" && /verif|confirm/i.test(m.subject)), "Resend verification sends the email (support role)", verify.text);
    ok((await call(`/admin/customers/${A}/password-reset`, "POST", {}, boss.token)).status === 429, "…rate-limited (one a minute)");

    console.log("\n6. Notes, profile, activity");
    const note = await call(`/admin/customers/${A}/support-note`, "POST", { body: "Called about invoice; resolved." }, sup.token);
    ok(note.status === 201 && (await call(`/admin/customers/${A}`, "GET", null, boss.token)).json.customer.notes[0]?.body === "Called about invoice; resolved.", "support adds an internal note");
    ok(!JSON.stringify((await call("/auth/me", "GET", null, alice.token)).json).includes("Called about invoice") && !JSON.stringify((await call("/billing", "GET", null, alice.token)).json).includes("Called about"), "…the customer never sees it");
    const prof = await call(`/admin/customers/${A}/profile`, "PUT", { website: "acme.test", industry: "Technology", location: "Austin, TX" }, boss.token);
    ok(prof.json.profile?.website === "acme.test", "Edit Details saves the CRM fields");
    const act = await call(`/admin/customers/${A}/activity`, "GET", null, boss.token);
    const kinds = new Set(act.json.activity.map((a) => a.kind));
    ok(kinds.has("adjustment") && kinds.has("project") && kinds.has("invoice") && kinds.has("support") && kinds.has("team"), "activity timeline: adjustment, project, invoice, support, team", JSON.stringify([...kinds]));
    ok((await call(`/admin/customers/${A}/projects`, "GET", null, boss.token)).json.projects.some((p) => p.name === "Keep me"), "projects tab lists the customer's projects");

    console.log("\n7. Plans through Stripe");
    stripeCalls.length = 0;
    const change = await call(`/admin/customers/${A}/plan`, "POST", { action: "change", planId: "power", period: "monthly", reason: "Upgrade requested" }, boss.token);
    const upd = stripeCalls.find((x) => x.method === "POST" && x.url === "/v1/subscriptions/sub_admin");
    ok(change.status === 200 && /items\[0\]\[price\]=price_power_m/.test(upd?.body ?? "") && /proration_behavior=create_prorations/.test(upd?.body ?? ""), "change plan updates the Stripe subscription (prorated)", upd?.body);
    ok((await call("/billing", "GET", null, alice.token)).json.wallet.plan.id === "pro", "…and the wallet waits for Stripe's invoice (no local shortcut)");
    stripeCalls.length = 0;
    const sched = await call(`/admin/customers/${A}/plan`, "POST", { action: "schedule", planId: "starter", period: "monthly" }, boss.token);
    ok(sched.status === 200 && stripeCalls.some((x) => x.url === "/v1/subscription_schedules" && /from_subscription=sub_admin/.test(x.body)) && stripeCalls.some((x) => x.url === "/v1/subscription_schedules/sub_sched_1" && /phases\[1\]\[items\]\[0\]\[price\]=price_starter_m/.test(x.body)), "schedule a downgrade at renewal (subscription schedule)", JSON.stringify(stripeCalls.map((x) => x.url)));
    stripeCalls.length = 0;
    const cancel = await call(`/admin/customers/${A}/plan`, "POST", { action: "cancel_at_period_end" }, boss.token);
    ok(cancel.status === 200 && stripeCalls.some((x) => x.url === "/v1/subscriptions/sub_admin" && /cancel_at_period_end=true/.test(x.body)), "cancel at renewal");
    const resume = await call(`/admin/customers/${A}/plan`, "POST", { action: "resume" }, boss.token);
    ok(resume.status === 200 && stripeCalls.some((x) => /cancel_at_period_end=false/.test(x.body)), "reactivate the subscription");
    const comp = await call(`/admin/customers/${bob.tenantId}/plan`, "POST", { action: "complimentary", planId: "business", reason: "Partner account" }, boss.token);
    ok(comp.status === 200 && (await call("/billing", "GET", null, bob.token)).json.wallet.plan.id === "business", "a super admin can assign a complimentary plan (ledger grant, audited)");
    ok((await call(`/admin/customers/${A}/plan`, "POST", { action: "complimentary", planId: "team", reason: "Partner deal" }, boss.token)).status === 409, "…but never over a paying Stripe subscription");
    ok((await call(`/admin/customers/${bob.tenantId}/plan`, "POST", { action: "complimentary", planId: "team", reason: "x" }, sup.token)).status === 403, "support can't touch plans");
    const dash2 = await call("/admin/dashboard", "GET", null, boss.token);
    ok(dash2.json.mrr.value === 59, "complimentary plans don't count as revenue");

    console.log("\n8. View as customer");
    const va = await call(`/admin/customers/${A}/view-as`, "POST", { reason: "Ticket 42" }, sup.token);
    const V = va.json.token;
    ok(va.status === 200 && /^orvview_/.test(V), "support starts a read-only customer view", va.text.slice(0, 100));
    const vMe = await call("/auth/me", "GET", null, V);
    ok(vMe.json.viewAs?.staffEmail === "support@orvyn.test" && vMe.json.principal?.tenantId === A && vMe.json.staff === null, "/auth/me shows the customer, labelled as a support session");
    ok((await call("/projects", "GET", null, V)).json.projects?.some((p) => p.name === "Keep me"), "it can read the customer's data");
    const w1 = await Promise.all([call("/projects", "POST", { name: "x" }, V), call("/sessions", "POST", { title: "x" }, V), call("/billing/checkout", "POST", { packId: "pack_10k" }, V)]);
    ok(w1.every((r) => r.status === 403 && r.json.code === "READ_ONLY_VIEW"), "every write is refused (403 READ_ONLY_VIEW)", w1.map((r) => r.status).join(","));
    ok((await call("/auth/ws-ticket", "POST", {}, V)).status === 401, "…and it can't open the chat socket");
    ok((await call("/admin/dashboard", "GET", null, V)).status === 401, "…or reach the admin API");
    await call("/auth/logout", "POST", {}, V);
    ok((await call("/projects", "GET", null, V)).status === 401, "ending the view revokes it");
    const vaAudit = (await call(`/admin/customers/${A}/audit`, "GET", null, boss.token)).json.audit.map((a) => a.action);
    ok(vaAudit.includes("support.view_as") && vaAudit.includes("support.view_as_end"), "start and end are audited");

    console.log("\n9. Isolation and internal data");
    const cross = await Promise.all([call(`/sessions`, "GET", null, bob.token), call(`/projects/${projBefore.id}`, "GET", null, bob.token)]);
    ok(!cross[0].json.sessions?.some((s) => s.tenantId === A) && cross[1].status === 404, "customer B can't read customer A's projects (404)");
    const costs = await call("/admin/provider-costs?days=30", "GET", null, boss.token);
    ok(costs.status === 200 && costs.json.models?.some((m) => /nebius/i.test(m.provider) || /GLM/i.test(m.model)), "provider costs show internal provider/model names to admins", JSON.stringify(costs.json.models?.slice(0, 2)));
    ok(!/nebius|GLM/i.test((await call("/billing/stats", "GET", null, bob.token)).text), "…while the customer's own usage never names them");
    const health = await call("/admin/health", "GET", null, boss.token);
    ok(health.status === 200 && health.json.checks.length === 10 && ["sandbox-docker", "sandbox-openshell"].every((id) => health.json.checks.some((c) => c.id === id)) && health.json.checks.every((c) => ["operational", "degraded", "down", "not_configured"].includes(c.status)) && !JSON.stringify(health.json).includes("99.9"), "system health: 10 real checks (incl. both sandbox runtimes), no invented uptime", JSON.stringify(health.json.checks.map((c) => `${c.id}:${c.status}`)));
    const auditAll = await call("/admin/audit?limit=100", "GET", null, boss.token);
    ok(auditAll.json.audit.length >= 10, "the global audit log holds every staff action");
    const adb = new DatabaseSync(join(dataDir, "auth.db"));
    let auditImmutable = false; try { adb.prepare(`DELETE FROM admin_audit`).run(); } catch { auditImmutable = true; }
    adb.close();
    ok(auditImmutable, "the audit log refuses deletes");
    for (const p of ["/admin/subscriptions", "/admin/usage", "/admin/invoices", "/admin/support", "/admin/plans", "/admin/topups", "/admin/flags", "/admin/integrations", "/admin/email-templates", "/admin/email-templates/password_reset", "/admin/workers", "/admin/backups", "/admin/staff", "/admin/notifications", "/admin/organizations"]) {
      const r = await call(p, "GET", null, boss.token);
      if (r.status !== 200) ok(false, `${p} answers`, `${r.status} ${r.text.slice(0, 200)}`);
    }
    ok(true, "every admin list endpoint answers");
    ok((await call("/admin/staff/" + boss.userId, "DELETE", null, boss.token)).status === 409, "you can't remove yourself");
  } catch (err) {
    ok(false, "admin run", err?.stack ?? String(err));
  } finally {
    server.kill(); model.close(); stripe.close();
    if (failures) console.log(log.join("").slice(-3000));
  }
  console.log(failures ? `\nADMIN API: FAIL (${failures} check(s))` : "\nADMIN API: PASS");
  process.exit(failures ? 1 : 0);
}

main();
