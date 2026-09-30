// scripts/acceptance/admin-portal.mjs
//
// The Admin Portal and the customer portal in Chromium, on separate hosts
// like production (admin host = "localhost", app host = "127.0.0.1"):
//   - A customer can't reach /admin (redirected to the admin host, where the
//     server refuses them); the admin API doesn't exist on the app host.
//   - A super admin signs in on the admin host: dashboard metrics load from
//     real data; search finds a customer; the account page opens; the Customer
//     Actions drawer drives Adjust Credits (+5,000 → ledger + audit + the
//     customer's own balance), Support Note, Password Reset, Resend
//     Verification, Pause (customer locked out, data intact), Reactivate,
//     Manage Plan (read from Stripe), View as Customer (read-only banner),
//     Audit Log.
//   - Screenshots at 1920×1080, 1600×900, 1440×900 and 1366×768 with no
//     page-level horizontal scroll.
//
// Usage (after building backend and web): node scripts/acceptance/admin-portal.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";

const PORT = 4891, MODEL_PORT = 4892, STRIPE_PORT = 4893;
const APP = `http://127.0.0.1:${PORT}`;
const ADMIN = `http://localhost:${PORT}`;
const WHSEC = "whsec_ap_test";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const webDist = join(repoRoot, "apps", "web", "dist");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-ap-data-"));
const mailDir = mkdtempSync(join(tmpdir(), "orvyn-ap-mail-"));
const shots = process.env.ORVYN_PORTAL_SHOTS || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const VENDOR = /nebius|fireworks|cheaper ?inference|zai-org|GLM|kimi/i;
const now = Math.floor(Date.now() / 1000);

const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "x" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const usage = { prompt_tokens: 9000, completion_tokens: 900, total_tokens: 9900 };
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Hi." }, finish_reason: "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Hi." } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
const stripe = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    const u = req.url ?? "";
    if (u.startsWith("/v1/subscriptions/sub_ap")) return res.end(JSON.stringify({ id: "sub_ap", status: "active", cancel_at_period_end: false, items: { data: [{ id: "si_1", price: { id: "price_team_m", recurring: { interval: "month" } }, current_period_start: now, current_period_end: now + 12 * 86400 }] } }));
    if (u.startsWith("/v1/invoices")) return res.end(JSON.stringify({ data: [0, 1, 2].map((i) => ({ id: `in_ap_${i}`, number: `INV-2026-00${98 - i}`, customer: "cus_ap", created: now - i * 30 * 86400, status: "paid", amount_paid: 39900, lines: { data: [{ description: "ORVYN Team" }] }, hosted_invoice_url: "https://invoice.stripe.test/x" })), has_more: false }));
    if (u.startsWith("/v1/payment_methods")) return res.end(JSON.stringify({ data: [{ card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 } }] }));
    if (u.startsWith("/v1/subscriptions")) return res.end(JSON.stringify({ data: [] }));
    if (u.startsWith("/v1/customers")) return res.end(JSON.stringify({ id: "cus_ap" }));
    res.statusCode = 404; res.end("{}");
  });
});

const call = async (base, path, method = "GET", body, token) => {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
const webhook = async (event) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  return fetch(`${APP}/api/v1/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}` }, body });
};
async function account(email, name, password = "a-long-password-1") {
  const reg = await call(APP, "/auth/register", "POST", { name, email, password });
  await call(APP, "/onboarding/provision", "POST", {}, reg.json.token);
  await call(APP, "/onboarding", "PUT", { step: "complete" }, reg.json.token);
  return { token: reg.json.token, tenantId: reg.json.principal?.tenantId, email, password };
}
const shot = async (page, name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`) }); } };
async function signIn(page, base, email, password) {
  await page.goto(`${base}/signin`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.click("[data-testid=auth-submit]");
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => stripe.listen(STRIPE_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-ap-proj-")), PORT: String(PORT), ORVYN_WEB_DIR: webDist,
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_MAIL_CAPTURE: mailDir, ORVYN_PUBLIC_ORIGIN: APP,
    ORVYN_APP_HOST: "127.0.0.1", ORVYN_ADMIN_HOST: "localhost",
    ORVYN_VAULT_KEY: Buffer.alloc(32, 8).toString("base64"), ORVYN_SUPER_ADMIN_EMAILS: "rm@kernel.test",
    ORVYN_AUTH_RATE_LIMIT_RPM: "1000", ORVYN_AUTH_SESSION_RATE_LIMIT_RPM: "5000",
    STRIPE_SECRET_KEY: "sk_test_ap", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_TEAM_MONTHLY: "price_team_m", STRIPE_PRICE_PRO_MONTHLY: "price_pro_m", STRIPE_PRICE_PACK_10K: "price_pack10k",
    MODEL_API_KEY: "k", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "nebius:zai-org/GLM-5.3-Flash", OPENAI_CODE_MODEL: "nebius:zai-org/GLM-5.3-Flash",
  };
  delete env.ORVYN_API_KEY; delete env.NODE_ENV;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "OPENROUTER_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "GOOGLE_CLIENT_ID", "GITHUB_CLIENT_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined) });
  let current = null;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${APP}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    // ---- seed real data ----
    const boss = await account("rm@kernel.test", "Royce McKnight", "Staff-Pass-123!");
    const acme = await account("john@acme.test", "John Smith");
    const others = [];
    for (const [e, n] of [["sarah@techstart.test", "Sarah Johnson"], ["mike@globalretail.test", "Mike Chen"], ["lisa@innovatelab.test", "Lisa Martinez"]]) others.push(await account(e, n));
    await call(ADMIN, "/admin/customers/" + acme.tenantId, "GET", null, boss.token); // seeds staff role from env
    await webhook({ id: "evt_ap1", type: "checkout.session.completed", data: { object: { id: "cs_ap", mode: "subscription", customer: "cus_ap", subscription: "sub_ap", payment_status: "paid", metadata: { accountId: acme.tenantId, kind: "subscription", planId: "team", period: "monthly" } } } });
    await webhook({ id: "evt_ap2", type: "invoice.paid", data: { object: { id: "in_ap_0", customer: "cus_ap", subscription: "sub_ap", amount_paid: 39900, subscription_details: { metadata: { accountId: acme.tenantId, planId: "team" } }, lines: { data: [{ price: { id: "price_team_m" }, period: { start: now, end: now + 12 * 86400 } }] } } } });
    await call(APP, "/projects", "POST", { name: "Marketing Site" }, acme.token);
    await call(APP, "/projects", "POST", { name: "Product Research" }, acme.token);
    for (const u of [acme, others[0]]) {
      const started = await call(APP, "/agent/stream/runs", "POST", { instruction: "Say hello", mode: "ask", composerMode: "auto", executionTarget: "auto" }, u.token);
      for (let i = 0; i < 60 && started.json.runId; i++) { const r = await call(APP, `/agent/stream/runs/${started.json.runId}/events.json`, "GET", null, u.token); if (["completed", "error", "failed"].includes(r.json.status)) break; await sleep(250); }
    }

    console.log("\n1. Separate hosts and RBAC");
    ok((await call(APP, "/admin/dashboard", "GET", null, boss.token)).status === 404, "the admin API doesn't exist on the customer host (even for staff)");
    ok((await call(ADMIN, "/admin/dashboard", "GET", null, acme.token)).status === 403, "on the admin host a customer gets 403");
    const redirect = await fetch(`${APP}/admin/customers`, { redirect: "manual" });
    ok(redirect.status === 302 && (redirect.headers.get("location") ?? "").startsWith(`${ADMIN}/admin/customers`), "/admin on the customer host redirects to the admin host", redirect.headers.get("location"));
    const adminShell = await (await fetch(`${ADMIN}/`)).text();
    ok(/orvyn-surface" content="admin"/.test(adminShell) && /noindex/.test(adminShell), "the admin host serves the Admin Portal (not indexed)");
    ok((await call(ADMIN, "/onboarding/providers")).json.google === false, "staff sign in with email/password on the admin host");

    // Customer tries the admin portal in the browser.
    const cctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cpage = await cctx.newPage();
    await signIn(cpage, ADMIN, acme.email, acme.password);
    await cpage.waitForSelector("[data-testid=admin-denied]", { timeout: 10000 });
    ok(/Admin access only/.test(await cpage.innerText("body")), "a customer who signs in on the admin host sees 'Admin access only'");
    await cctx.close();

    console.log("\n2. Super admin: dashboard");
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
    const page = await ctx.newPage(); current = page;
    const errors = [];
    page.on("pageerror", (e) => { errors.push(e.message); console.log("  [pageerror]", e.message.slice(0, 300)); });
    await signIn(page, ADMIN, boss.email, boss.password);
    await page.waitForSelector("[data-testid=admin-dashboard]", { timeout: 15000 });
    await page.waitForFunction(() => /5/.test(document.querySelector("[data-testid=kpi-users] .a-kpi__value")?.textContent ?? ""), null, { timeout: 10000 });
    ok(true, "the admin host opens straight into the Admin Dashboard after sign-in");
    const kpi = await page.innerText("[data-testid=kpi-users]") + await page.innerText("[data-testid=kpi-paid]") + await page.innerText("[data-testid=kpi-mrr]");
    ok(/5/.test(kpi) && /\$399/.test(kpi), "metrics come from real data (5 users, $399 MRR from the Team subscription)", kpi.replace(/\s+/g, " "));
    await page.waitForSelector("[data-testid=customer-row]");
    ok((await page.$$("[data-testid=customer-row]")).length === 5, "the customers table lists the 5 accounts");
    await page.click(`[data-testid=customer-row][data-id="${acme.tenantId}"]`);
    await page.waitForSelector("[data-testid=selected-customer]");
    await page.waitForFunction(() => /cus_ap/.test(document.querySelector("[data-testid=selected-customer]")?.textContent ?? ""), null, { timeout: 8000 });
    ok(true, "selecting a row shows its details (Stripe customer and subscription ids)");
    await sleep(500);
    for (const [w, h] of [[1920, 1080], [1600, 900], [1440, 900], [1366, 768]]) {
      await page.setViewportSize({ width: w, height: h }); await sleep(300);
      const sw = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
      if (sw[0] > sw[1]) ok(false, `no page-level horizontal scroll at ${w}×${h}`, JSON.stringify(sw));
      await shot(page, `admin-dashboard-${w}`);
    }
    ok(true, "dashboard renders at 1920/1600/1440/1366 without page-level horizontal scroll");
    await page.setViewportSize({ width: 1600, height: 900 });

    console.log("\n3. Search → Customer Account");
    await page.fill("[data-testid=admin-search]", "john@acme");
    await page.waitForSelector(".adm-pop__item");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-testid=customer-account]");
    await page.waitForFunction(() => /John Smith|acme/i.test(document.querySelector("[data-testid=acct-name]")?.textContent ?? ""), null, { timeout: 8000 });
    ok(page.url().includes(`/admin/customers/${acme.tenantId}`), "global search opens the customer account", page.url());
    await page.waitForSelector("[data-testid=acct-invoices]");
    ok(/INV-2026-0098/.test(await page.innerText("[data-testid=acct-invoices]")), "recent invoices come from Stripe");
    await page.waitForSelector("[data-testid=acct-activity]");
    await page.setViewportSize({ width: 1920, height: 1080 }); await sleep(400);
    await shot(page, "admin-account-1920");
    await page.setViewportSize({ width: 1600, height: 900 });

    console.log("\n4. Customer Actions drawer");
    await page.click("[data-testid=customer-actions]");
    await page.waitForSelector("[data-testid=actions-drawer]");
    const drawer = await page.innerText("[data-testid=actions-drawer]");
    ok(["View Account", "Open Subscription", "Usage & Credits", "Invoices", "Projects & Workspaces", "View as Customer", "Manage Plan", "Adjust Credits", "Send Password Reset", "Resend Verification", "Add Support Note", "Pause Account", "View Audit Log"].every((x) => drawer.includes(x)), "the drawer has every grouped action", drawer.replace(/\s+/g, " ").slice(0, 300));
    await shot(page, "admin-actions-drawer");
    // Adjust credits +5,000
    const before = (await call(APP, "/billing", "GET", null, acme.token)).json.wallet.availableBalance;
    await page.click("[data-testid=act-credits]");
    await page.fill("[data-testid=adjust-amount]", "5000");
    await page.fill("[data-testid=adjust-reason]", "Launch promotion");
    await page.click("[data-testid=adjust-submit]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=adjust-submit]"), null, { timeout: 8000 });
    const after = (await call(APP, "/billing", "GET", null, acme.token)).json.wallet.availableBalance;
    ok(after === before + 5000, "Adjust Credits +5,000: the customer's own balance shows it", `${before} → ${after}`);
    const bdb = new DatabaseSync(join(dataDir, "billing.sqlite"));
    const entries = bdb.prepare(`SELECT * FROM ledger_entries WHERE account_id = ? AND type = 'admin_adjustment'`).all(acme.tenantId);
    bdb.close();
    ok(entries.length === 1 && entries[0].amount === 5000 && entries[0].actor === "staff:rm@kernel.test" && /Launch promotion/.test(entries[0].meta), "…as one immutable ledger entry with the admin and reason", JSON.stringify(entries));
    // Support note, reset, verification
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-note]");
    await page.fill("[data-testid=note-body]", "Customer asked about annual billing."); await page.click("[data-testid=note-submit]");
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-reset]"); await page.click("[data-testid=confirm-action]");
    await page.waitForFunction(() => !document.querySelector("[data-testid=confirm-action]"), null, { timeout: 8000 });
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-verify]"); await page.click("[data-testid=confirm-action]");
    await sleep(600);
    const mails = readdirSync(mailDir).map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf8")));
    ok(mails.some((m) => m.to === "john@acme.test" && /reset/i.test(m.subject)) && mails.some((m) => m.to === "john@acme.test" && /verif|confirm/i.test(m.subject)), "Send Password Reset and Resend Verification send real emails", JSON.stringify(mails.map((m) => m.subject)));
    // Pause → customer locked out → reactivate
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-pause]");
    await page.fill("[data-testid=pause-reason]", "Chargeback review");
    await page.fill("[data-testid=pause-confirm]", "PAUSE");
    await page.click("[data-testid=pause-submit]");
    await page.waitForFunction(() => /Paused/.test(document.querySelector("[data-testid=customer-account]")?.textContent ?? ""), null, { timeout: 8000 });
    ok((await call(APP, "/projects", "GET", null, acme.token)).json.code === "ACCOUNT_PAUSED", "Pause: the customer's API is refused");
    const cc = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const cp = await cc.newPage();
    await signIn(cp, APP, acme.email, acme.password);
    await cp.waitForSelector("[data-testid=account-paused]", { timeout: 10000 });
    ok(true, "…and the customer portal shows 'Your account is paused'");
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-reactivate]"); await page.click("[data-testid=confirm-action]");
    await page.waitForFunction(() => !/Paused \d|Paused just|Paused .* by/.test(document.querySelector("[data-testid=customer-account]")?.textContent ?? ""), null, { timeout: 8000 });
    const projects = (await call(APP, "/projects", "GET", null, acme.token)).json.projects ?? [];
    ok(projects.length === 2, "Reactivate restores access with all projects intact", JSON.stringify(projects.map((p) => p.name)));
    await cp.reload(); await cp.waitForSelector("[data-testid=stat-plan]", { timeout: 10000 });
    ok(/10,|Team/.test(await cp.innerText("body")) && /Team/.test(await cp.innerText("[data-testid=stat-plan]")), "…the customer portal is back (Team plan)");
    ok((await cp.innerText("[data-testid=stat-topup]")).includes("5,000"), "…and shows the 5,000 granted credits as top-up balance");
    const home = await cp.innerText("body");
    ok(/Welcome back, John/.test(home) && /What can I help with/.test(home) && /Manage plan/.test(home) && !VENDOR.test(home), "customer Home: orb greeting, quick actions, no vendor names");
    await shot(cp, "cloud-home-1440");
    ok(!(await cp.$("[data-testid=open-admin]")), "a customer's menu has no Admin Portal link");
    await cc.close();
    // Manage plan (reads Stripe)
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-plan]");
    await page.waitForSelector("[data-testid=plan-change-now]", { timeout: 10000 });
    ok(/active/.test(await page.innerText(".modal")), "Manage Plan reads the live subscription from Stripe");
    // Escape closes the modal (as every portal modal does); Close is only needed if it is still open.
    await page.keyboard.press("Escape"); if (await page.isVisible(".modal__actions >> text=Close")) await page.click(".modal__actions >> text=Close");
    // Audit log tab
    await page.click("[data-testid=tab-audit]");
    await page.waitForSelector("[data-testid=acct-audit]");
    const audit = await page.innerText("[data-testid=acct-audit]");
    ok(["Admin credit adjustment", "Support note added", "Password reset sent", "Verification email sent", "Account paused", "Account reactivated"].every((x) => audit.includes(x)), "the account's audit log records every action", audit.slice(0, 400));
    await shot(page, "admin-account-audit");

    console.log("\n5. View as customer");
    await page.click("[data-testid=tab-overview]");
    await page.click("[data-testid=customer-actions]"); await page.click("[data-testid=act-viewas]");
    const [popup] = await Promise.all([ctx.waitForEvent("page"), page.click("[data-testid=viewas-start]")]);
    await popup.waitForSelector("[data-testid=view-as-banner]", { timeout: 15000 });
    ok(/read-only/.test(await popup.innerText("[data-testid=view-as-banner]")), "the customer view opens with a visible read-only support banner");
    await popup.goto(`${ADMIN}/chats`).catch(() => undefined);
    await popup.waitForSelector("[data-testid=viewas-composer]", { timeout: 10000 }).catch(() => null);
    ok(Boolean(await popup.$("[data-testid=viewas-composer]")), "…and chat sending is disabled");
    await shot(popup, "view-as");
    const tok = await popup.evaluate(() => sessionStorage.getItem("orvyn.viewas"));
    ok((await call(ADMIN, "/projects", "POST", { name: "x" }, tok)).status === 403, "…the server refuses writes from it");
    ok(await page.evaluate(() => Boolean(localStorage.getItem("orvyn.session"))), "…and the staff member's own session is untouched");
    await popup.close();

    console.log("\n6. Other admin pages");
    for (const [path, want] of [["/admin/customers", "Customers"], ["/admin/organizations", "Organization ID"], ["/admin/subscriptions", "Renews"], ["/admin/usage", "Top customers"], ["/admin/invoices", "INV-2026"], ["/admin/support", "Support notes"], ["/admin/plans", "Starter"], ["/admin/topups", "credits"], ["/admin/flags", "Cloud mode"], ["/admin/integrations", "Stripe"], ["/admin/email-templates", "Password reset"], ["/admin/provider-costs", "By provider and model"], ["/admin/health", "Stripe Webhooks"], ["/admin/workers", "Execution workers"], ["/admin/backups", "Backups"], ["/admin/audit", "Admin credit adjustment"], ["/admin/settings", "rm@kernel.test"]]) {
      await page.goto(`${ADMIN}${path}`);
      const found = await page.waitForSelector(`text=${want}`, { timeout: 10000 }).catch(() => null);
      ok(Boolean(found), `${path} renders real data`);
    }
    await page.goto(`${ADMIN}/admin/provider-costs`); await page.waitForSelector("[data-testid=costs-table]");
    ok(/nebius/i.test(await page.innerText("[data-testid=costs-table]")), "provider costs name internal providers (admin only)");
    await shot(page, "admin-provider-costs");
    await page.goto(`${ADMIN}/admin/health`); await page.waitForSelector("[data-testid=health-table]");
    ok(!/99\.9/.test(await page.innerText("[data-testid=health-table]")), "system health shows real checks, no invented uptime");
    await shot(page, "admin-health");
    ok(errors.length === 0, "no uncaught errors in the Admin Portal", errors.join(" | "));
  } catch (err) {
    ok(false, "admin portal run", err?.stack ?? String(err));
    if (current) { await shot(current, "admin-failure").catch(() => undefined); console.log("  at", current.url()); }
  } finally {
    await browser.close().catch(() => undefined);
    server.kill(); model.close(); stripe.close();
    if (failures) console.log(log.join("").slice(-2500));
  }
  console.log(failures ? `\nADMIN PORTAL: FAIL (${failures} check(s))` : "\nADMIN PORTAL: PASS");
  process.exit(failures ? 1 : 0);
}

main();
