// scripts/acceptance/onboarding-api.mjs
//
// The onboarding backend end to end over HTTP (ORVYN Cloud mode, real auth,
// real ledger, real email pipeline captured to files):
//   1. Signup creates the user + Personal Organization and an onboarding
//      profile at "verification"; a verification email is sent.
//   2. Steps after verification are refused until the email is verified.
//   3. The link in the email verifies the account; the profile moves on.
//   4. Provisioning reports REAL state: account, workspace, Free plan,
//      2,000 credits (issued once, even when provisioning runs twice), ORION.
//   5. Answers persist server-side; a new session (another device, or the
//      app reopened) resumes at the same step with the same answers.
//   6. Memory off / work style / response style reach the user's workspace.
//   7. Existing accounts are never asked to sign up again ("finish setup").
//   8. Public plans come from the billing config (Free $0 … Team $399).
//   9. Analytics events are recorded without emails or passwords.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/onboarding-api.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 4791;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-onb-data-"));
const mailDir = mkdtempSync(join(tmpdir(), "orvyn-onb-mail-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
const mails = () => readdirSync(mailDir).sort().map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf8")));

async function main() {
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-onb-proj-")),
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"), ORVYN_MAIL_CAPTURE: mailDir, ORVYN_PUBLIC_ORIGIN: BASE,
  };
  delete env.ORVYN_API_KEY;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) delete env[k];
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Signup");
    const reg = await call("/auth/register", "POST", { name: "Royce", email: "royce@example.com", password: "correct horse battery" });
    ok(reg.status === 201 && reg.json.token && reg.json.verification?.required === true && reg.json.verification?.sent === true, "account created, verification email sent", JSON.stringify(reg.json).slice(0, 300));
    const token = reg.json.token;
    const first = await call("/onboarding", "GET", null, token);
    ok(first.json.profile?.currentStep === "verification" && first.json.user?.emailVerified === false, "onboarding starts at 'Check your inbox'", JSON.stringify(first.json.profile));
    const unverified = await call("/projects", "GET", null, token);
    ok(unverified.status === 403 && unverified.json.code === "EMAIL_NOT_VERIFIED", "a new, unverified account cannot go straight into ORVYN", `${unverified.status} ${JSON.stringify(unverified.json)}`);
    const sent = mails();
    ok(sent.length === 1 && sent[0].to === "royce@example.com" && /Confirm your ORVYN account/.test(sent[0].subject), "one verification email to the right address", JSON.stringify(sent.map((m) => [m.to, m.subject])));

    console.log("\n2. No skipping verification");
    const early = await call("/onboarding", "PUT", { step: "primary_use" }, token);
    ok(early.status === 409 && early.json.code === "EMAIL_NOT_VERIFIED", "a later step is refused until the email is verified", `${early.status} ${early.json.code}`);
    const earlyProv = await call("/onboarding/provision", "POST", {}, token);
    ok(earlyProv.json.provisioning?.every((s) => !s.done || s.id === "workspace" || s.id === "orion") && !earlyProv.json.provisioning?.find((s) => s.id === "credits")?.done, "no credits are issued before verification", JSON.stringify(earlyProv.json.provisioning));

    console.log("\n3. The email link");
    const link = (sent[0].text.match(/https?:\/\/\S+\/auth\/verify\?token=\S+/) ?? [])[0];
    const verified = link ? await fetch(link) : null;
    ok(verified?.status === 200 && /Email verified/.test(await verified.text()), "the link verifies the account", link ?? "no link");
    const reused = link ? await fetch(link) : null;
    ok(reused?.status === 400, "the link works once");
    const afterVerify = await call("/onboarding", "GET", null, token);
    ok(afterVerify.json.user?.emailVerified === true && afterVerify.json.profile?.currentStep === "provisioning", "the app sees it on its own (next poll: provisioning)", JSON.stringify(afterVerify.json.profile));

    console.log("\n4. Provisioning is real, and idempotent");
    const prov = await call("/onboarding/provision", "POST", {}, token);
    ok(prov.json.provisioning?.every((s) => s.done), "every checklist line is done (account, workspace, Free plan, credits, ORION)", JSON.stringify(prov.json.provisioning));
    ok(prov.json.plan?.id === "free" && prov.json.plan?.monthlyCredits === 2000, "the wallet is on Free with 2,000 monthly credits", JSON.stringify(prov.json.plan));
    ok(prov.json.profile?.currentStep === "name", "onboarding moves on to 'What should I call you?'", prov.json.profile?.currentStep);
    await call("/onboarding/provision", "POST", {}, token);
    await call("/onboarding/provision", "POST", {}, token);
    const bill = new DatabaseSync(join(dataDir, "billing.sqlite"));
    const grants = bill.prepare(`SELECT amount AS credits FROM ledger_entries WHERE type = 'monthly_grant'`).all();
    ok(grants.length === 1 && grants[0].credits === 2000, "2,000 credits were issued exactly once", JSON.stringify(grants));
    bill.close();
    const wallet = await call("/billing", "GET", null, token);
    ok(wallet.status === 200 && (wallet.json.includedBalance === 2000 || wallet.json.snapshot?.includedBalance === 2000 || JSON.stringify(wallet.json).includes('"includedBalance":2000')), "the signed-in workspace sees the same 2,000-credit wallet", JSON.stringify(wallet.json).slice(0, 200));

    console.log("\n5. Answers persist; another device resumes at the same step");
    const steps = [
      ["name", "primary_use", { name: "Royce" }],
      ["primary_use", "goals", { primaryUse: ["software", "devops"] }],
      ["goals", "work_style", { goals: ["build_software", "servers_deployments"], goalOther: "" }],
    ];
    for (const [done, next, answers] of steps) {
      const r = await call("/onboarding", "PUT", { step: next, completed: [done], answers }, token);
      if (!ok(r.status === 200 && r.json.profile.currentStep === next, `${done} → ${next}`, `${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)) break;
    }
    const login = await call("/auth/login", "POST", { email: "royce@example.com", password: "correct horse battery" });
    const other = await call("/onboarding", "GET", null, login.json.token);
    ok(other.json.profile?.currentStep === "work_style" && other.json.profile?.answers?.primaryUse?.join(",") === "software,devops", "a second session (desktop after web, or after a restart) resumes at 'How should ORION work with you?' with the same answers", JSON.stringify(other.json.profile));
    const me = await call("/auth/me", "GET", null, login.json.token);
    ok(me.json.user?.name === "Royce" && me.json.onboarding?.step === "work_style", "the account's name and onboarding step are the same everywhere", JSON.stringify(me.json.onboarding));

    console.log("\n6. Preferences reach ORION");
    await call("/onboarding", "PUT", { step: "response_style", completed: ["work_style"], answers: { workStyle: "plan_first" } }, token);
    await call("/onboarding", "PUT", { step: "memory", completed: ["response_style"], answers: { responseStyle: "concise" } }, token);
    const mem = await call("/onboarding", "PUT", { step: "workspace", completed: ["memory"], answers: { memory: false } }, token);
    ok(mem.json.profile?.answers?.memory === false, "Keep Memory Off is saved");
    const tenantDb = `${reg.json.principal?.tenantId}.db`;
    const prefs = tenantDb ? new DatabaseSync(join(dataDir, tenantDb)).prepare(`SELECT value FROM settings WHERE key = 'orion.preferences'`).get() : null;
    const parsed = prefs ? JSON.parse(prefs.value) : {};
    ok(parsed.memory === false && parsed.workStyle === "plan_first" && parsed.responseStyle === "concise" && parsed.name === "Royce", "the workspace ORION runs in holds the choices (memory off, plan first, concise)", JSON.stringify(parsed));

    console.log("\n6b. The account gate: no ORVYN before setup is finished");
    const early1 = await call("/projects", "GET", null, token);
    ok(early1.status === 403 && early1.json.code === "ONBOARDING_REQUIRED", "a verified account mid-setup cannot use ORVYN (projects)", `${early1.status} ${JSON.stringify(early1.json)}`);
    const earlyRun = await call("/agent/stream/runs", "POST", { prompt: "hello" }, token);
    ok(earlyRun.status === 403 && earlyRun.json.code === "ONBOARDING_REQUIRED", "…nor start a run", `${earlyRun.status} ${JSON.stringify(earlyRun.json)}`);
    const wsDenied = await new Promise((resolveWs) => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?token=${encodeURIComponent(token)}`);
      const t = setTimeout(() => { try { sock.close(); } catch {} resolveWs(null); }, 4000);
      sock.onmessage = (e) => { clearTimeout(t); try { resolveWs(JSON.parse(String(e.data))); } catch { resolveWs(null); } try { sock.close(); } catch {} };
      sock.onerror = () => { clearTimeout(t); resolveWs(null); };
    });
    ok(wsDenied?.code === "ONBOARDING_REQUIRED", "…nor chat over the socket", JSON.stringify(wsDenied));
    const walletMid = await call("/billing", "GET", null, token);
    ok(walletMid.status === 200, "the setup screens can still read the plan and wallet");
    for (const [stepName, doneName] of [["github", "workspace"], ["plan", "github"], ["recap", "plan"], ["first_mission", "recap"], ["complete", "first_mission"]]) {
      await call("/onboarding", "PUT", { step: stepName, completed: [doneName] }, token);
    }
    const finished = await call("/onboarding", "GET", null, token);
    ok(Boolean(finished.json.profile?.completedAt), "onboarding completes", JSON.stringify(finished.json.profile));
    const after = await call("/projects", "GET", null, token);
    ok(after.status === 200, "after setup, ORVYN opens (projects 200)", `${after.status} ${JSON.stringify(after.json).slice(0, 200)}`);

    console.log("\n7. Existing accounts are not asked to sign up again");
    const legacy = await call("/auth/register", "POST", { email: "old@example.com", password: "another good pass" });
    // Simulate an account from before onboarding existed: no profile yet.
    const auth = new DatabaseSync(join(dataDir, "auth.db"));
    auth.prepare(`DELETE FROM onboarding_profiles WHERE user_id = ?`).run(legacy.json.user.id);
    auth.close();
    const legacyView = await call("/onboarding", "GET", null, legacy.json.token);
    ok(legacyView.json.profile?.currentStep === "provisioning" && legacyView.json.user?.emailVerified === true && !legacyView.json.profile?.completedSteps.includes("name"), "an existing account resumes at 'finish setup' (no signup, no verification)", JSON.stringify(legacyView.json.profile));
    const legacyGate = await call("/projects", "GET", null, legacy.json.token);
    ok(legacyGate.status === 403 && legacyGate.json.code === "ONBOARDING_REQUIRED", "…and finishes setup before using ORVYN", `${legacyGate.status} ${legacyGate.json.code}`);

    console.log("\n8. Plans come from the billing configuration");
    const plans = await call("/onboarding/plans");
    const table = (plans.json.plans ?? []).map((p) => `${p.id}:${p.priceMonthlyUsd}:${p.monthlyCredits}`).join(" ");
    ok(table === "free:0:2000 starter:29:24000 pro:59:60000 power:99:120000 business:199:240000 team:399:500000", "Free $0 · Starter $29 · Pro $59 · Power $99 · Business $199 · Team $399", table);
    ok(plans.json.plans?.find((p) => p.id === "pro")?.priceAnnualUsd === 590, "annual pricing (≈2 months free)");

    console.log("\n9. Change email / resend");
    const r2 = await call("/auth/register", "POST", { email: "typo@exampel.com", password: "yet another pass" });
    const changed = await call("/auth/verification/change-email", "POST", { email: "fixed@example.com" }, r2.json.token);
    ok(changed.status === 200 && changed.json.email === "fixed@example.com" && changed.json.sent === true, "Change email updates the address and sends a new link", JSON.stringify(changed.json));
    const again = await call("/auth/verification/resend", "POST", {}, r2.json.token);
    ok(again.status === 429, "Resend is limited to once a minute");

    console.log("\n10. Analytics without personal data");
    const db = new DatabaseSync(join(dataDir, "auth.db"));
    const events = db.prepare(`SELECT name, props FROM analytics_events`).all();
    db.close();
    const names = new Set(events.map((e) => e.name));
    ok(["signup_completed", "email_verified", "onboarding_step_completed", "onboarding_step_viewed"].every((n) => names.has(n)), "signup, verification and step events are recorded", [...names].join(","));
    ok(!events.some((e) => /@|password|orvver_|orvsess_/.test(e.props)), "no email address, password or token in any event");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL");
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-2000));
  console.log(failures === 0 ? "\nONBOARDING API: PASS" : `\nONBOARDING API: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
