// scripts/acceptance/onboarding-ui.mjs
//
// The ORVYN onboarding in the real desktop app against a real backend
// (accounts, email verification captured to files, ledger, onboarding state):
//   1. A fresh install opens onboarding (not the app) at "ORVYN is online."
//   2. Create Free Account → "Check your inbox"; the emailed link verifies
//      the account and the app moves on by itself.
//   3. "Setting up your workspace…" shows real checkmarks, then "What should
//      I call you?" with the account name.
//   4. Primary use, goals (multi-select), then the app is closed at "How
//      should ORION work with you?" and reopened: it resumes there.
//   5. Work style, response style, memory, workspace, GitHub (later), plan
//      (2,000 monthly credits from the server), View Plans (from billing).
//   6. Recap: Edit returns to that step and back to the recap.
//   7. First mission starts a real ORION run and opens the app.
//   8. Web → desktop: an account onboarded on the web to "memory" opens the
//      desktop app at "memory" (same user, same onboarding record).
//   9. An existing install (recent projects, no account) is never interrupted.
// Screenshots of every screen are saved for visual review.
//
// Usage (after `npm run build -w @orvyn/backend` and `npm run build -w @orvyn/desktop`):
//   xvfb-run -a node scripts/acceptance/onboarding-ui.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4801, MODEL_PORT = 4802;
const BASE = `http://localhost:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-onbui-"));
const dataDir = join(work, "data");
const mailDir = join(work, "mail");
const shots = process.env.ONBOARDING_SHOTS || join(work, "shots");
mkdirSync(shots, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const runs = [];

// A scripted model for ORION's first mission.
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const user = JSON.stringify(body.messages ?? []);
    if (/Research a topic for me/.test(user)) runs.push("research");
    const text = /ORVYN VERIFIER/.test(user) ? "VERDICT: PASS" : "Happy to help. What topic should I research?";
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

const api = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch {}
  return { status: r.status, json: j };
};
const mails = () => { try { return readdirSync(mailDir).sort().map((f) => JSON.parse(readFileSync(join(mailDir, f), "utf8"))); } catch { return []; } };

/** Close the app; if Electron does not exit promptly, kill it (a hung quit must not hang the suite). */
async function closeApp(app) {
  const proc = app.process();
  const done = app.close().then(() => true, () => true);
  const exited = await Promise.race([done, sleep(10000).then(() => false)]);
  if (!exited) { console.log("    (app.close timed out; killing)"); try { proc.kill("SIGKILL"); } catch {} await sleep(500); }
}

async function launch(userData, extraEnv = {}) {
  const app = await _electron.launch({
    executablePath: electronBin,
    args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server", "--password-store=basic"],
    env: { ...process.env, ORVYN_CLOUD_URL: BASE, ORVYN_SKIP_ONBOARDING: "", ORVYN_TEST_PLAINTEXT_KEYSTORE: "1", ...extraEnv },
  });
  const win = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1440, 900); w.setPosition(0, 0); });
  return { app, win };
}
const step = (win) => win.locator("[data-testid=onboarding]").getAttribute("data-step", { timeout: 500 }).catch(() => null);
async function waitStep(win, want, ms = 20000) {
  for (let i = 0; i < ms / 200; i++) { if ((await step(win)) === want) return true; await sleep(200); }
  return false;
}
async function shot(win, name) { await sleep(450); await win.screenshot({ path: join(shots, `${name}.png`) }).catch(() => undefined); }
const cont = (win) => win.getByRole("button", { name: /^Continue/ }).first().click();

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    ORVYN_MAIL_CAPTURE: mailDir, ORVYN_PUBLIC_ORIGIN: BASE,
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "SMTP_HOST", "SMTP_USER", "SMTP_PASS"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let app, win;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    const userData = join(work, "fresh-install");
    ({ app, win } = await launch(userData));

    console.log("\n1. Fresh install");
    ok(await waitStep(win, "welcome"), "onboarding opens (not the app) at the welcome screen");
    ok(await win.getByText("ORVYN is online.").isVisible(), "“ORVYN is online.”");
    ok(await win.locator(".ob-orb").first().isVisible(), "the ORVYN orb is shown");
    await sleep(1900); await shot(win, "01-welcome");
    await win.getByRole("button", { name: /Let's get started/ }).click();

    console.log("\n2. Account + email verification");
    ok(await waitStep(win, "signup"), "Create your ORVYN account");
    await shot(win, "02-signup");
    await win.locator("#ob-name").fill("Royce");
    await win.locator("#ob-email").fill("royce@example.com");
    await win.locator("#ob-password").fill("Carrier-Grade-2026!");
    await win.getByRole("button", { name: "Create Free Account" }).click();
    ok(await waitStep(win, "verification"), "Check your inbox", String(await step(win)));
    ok(await win.getByText("royce@example.com").isVisible().catch(() => false), "shows the address the link went to");
    await shot(win, "03-verification");
    const link = (mails()[0]?.text.match(/https?:\/\/\S+\/auth\/verify\?token=\S+/) ?? [])[0];
    ok(Boolean(link), "a verification email was sent");
    if (link) await fetch(link);

    console.log("\n3. Provisioning (real)");
    const sawProvisioning = await waitStep(win, "provisioning", 10000);
    if (sawProvisioning) await shot(win, "04-provisioning");
    ok(await waitStep(win, "name", 20000), "after the real setup: “What should I call you?”", String(await step(win)));
    const acct = await api("/auth/login", "POST", { email: "royce@example.com", password: "Carrier-Grade-2026!" });
    const view = await api("/onboarding", "GET", null, acct.json.token);
    ok(view.json.provisioning?.every((p) => p.done) && view.json.plan?.monthlyCredits === 2000, "the server shows every setup step done and the Free plan", JSON.stringify(view.json.provisioning));
    ok((await win.locator("#ob-callme").inputValue()) === "Royce", "the name comes from the account");
    await shot(win, "05-name");
    await cont(win);

    console.log("\n4. Primary use, goals — then close and reopen");
    ok(await waitStep(win, "primary_use"), "What best describes what you'll use ORVYN for?");
    await win.getByRole("button", { name: "Software Development" }).click();
    await win.getByRole("button", { name: "Server / DevOps" }).click();
    await shot(win, "06-primary-use");
    await cont(win);
    ok(await waitStep(win, "goals"), "What do you want ORVYN to help you accomplish?");
    await win.getByRole("checkbox", { name: /Build software faster/ }).click();
    await win.getByRole("checkbox", { name: /Manage servers/ }).click();
    await shot(win, "07-goals");
    await cont(win);
    ok(await waitStep(win, "work_style"), "How should ORION work with you?");
    await closeApp(app);
    console.log("    (closed; reopening)");
    ({ app, win } = await launch(userData));
    await sleep(3000); await shot(win, "07b-reopened");
    ok(await waitStep(win, "work_style", 20000), "reopened: resumes at “How should ORION work with you?” (server-side state)", String(await step(win)));
    await shot(win, "08-work-style");

    console.log("\n5. The rest of setup");
    await cont(win);
    ok(await waitStep(win, "response_style"), "How should ORION communicate?");
    await win.getByRole("radio", { name: /Concise/ }).click();
    await shot(win, "09-response-style");
    await cont(win);
    ok(await waitStep(win, "memory"), "Project Memory");
    await shot(win, "10-memory");
    await cont(win);
    ok(await waitStep(win, "workspace"), "Where should we start?");
    await shot(win, "11-workspace");
    await win.getByRole("radio", { name: /Start without a project/ }).click();
    await cont(win);
    ok(await waitStep(win, "github"), "Connect GitHub (optional)");
    await shot(win, "12-github");
    await win.getByRole("button", { name: "Do this later" }).click();
    ok(await waitStep(win, "plan"), "Your plan");
    ok(await win.getByText("2,000 monthly credits").isVisible().catch(() => false), "2,000 monthly credits (from the server's entitlements)");
    ok(await win.getByText("500 credits per 5 hours (rolling)").isVisible().catch(() => false), "500 credits per 5 hours (rolling)");
    await shot(win, "13-plan");
    await win.getByRole("button", { name: "View Plans" }).click();
    await win.getByText("Choose your plan").waitFor({ timeout: 5000 }).catch(() => undefined);
    await sleep(600);
    const planText = await win.locator("[data-testid=onboarding]").innerText();
    ok(/Starter[\s\S]*\$29[\s\S]*Pro[\s\S]*\$59[\s\S]*Power[\s\S]*\$99[\s\S]*Business[\s\S]*\$199[\s\S]*Team[\s\S]*\$399/.test(planText), "View Plans lists Free, Starter $29, Pro $59, Power $99, Business $199, Team $399", planText.slice(0, 300));
    await shot(win, "13b-plans");
    await win.getByRole("button", { name: /Yearly/ }).click();
    ok(/\$590/.test(await win.locator("[data-testid=onboarding]").innerText()), "Yearly shows annual prices (Pro $590)");
    await win.getByRole("button", { name: /Back to your plan/ }).click();
    await win.getByRole("button", { name: /Continue Free/ }).click();

    console.log("\n6. Recap edits");
    ok(await waitStep(win, "recap"), "Ready to go.");
    const recap = await win.locator(".ob-recap").innerText();
    ok(/Royce/.test(recap) && /Software Development, Server \/ DevOps/.test(recap) && /Concise/.test(recap) && /Enabled/.test(recap), "the recap shows the answers", recap);
    await shot(win, "14-recap");
    await win.getByRole("button", { name: "Edit Work style" }).click();
    ok(await waitStep(win, "work_style"), "Edit returns to the work style step");
    await win.getByRole("radio", { name: /Plan First/ }).click();
    await cont(win);
    ok(await waitStep(win, "recap"), "…and Continue returns to the recap");
    ok(/Plan First/.test(await win.locator(".ob-recap").innerText()), "with the change");
    await win.getByRole("button", { name: /Enter ORVYN/ }).click();

    console.log("\n7. First mission");
    ok(await waitStep(win, "first_mission"), "What should we do first?");
    await shot(win, "15-first-mission");
    const puts = [];
    win.on("response", async (r) => { if (/\/onboarding$/.test(r.url()) && r.request().method() === "PUT") puts.push(`${r.status()} ${(r.request().postData() ?? "").slice(0, 60)} ${(await r.text().catch(() => "")).slice(0, 160)}`); });
    win.on("requestfailed", (r) => { if (/onboarding/.test(r.url())) puts.push(`FAILED ${r.method()} ${r.failure()?.errorText}`); });
    await win.getByRole("button", { name: /Research a topic/ }).click();
    await win.locator("[data-testid=onboarding]").waitFor({ state: "detached", timeout: 15000 }).catch(() => undefined);
    ok(!(await win.locator("[data-testid=onboarding]").count()), "ORVYN opens after the first mission is chosen");
    let started = false;
    for (let i = 0; i < 60 && !started; i++) { started = runs.includes("research") || /Research a topic for me/.test(await win.locator("body").innerText()); await sleep(250); }
    ok(started, "the first mission is a real ORION run");
    await sleep(1500); await shot(win, "16-first-mission-running");
    const done = await api("/onboarding", "GET", null, acct.json.token);
    ok(Boolean(done.json.profile?.completedAt) && done.json.profile?.answers?.workStyle === "plan_first", "onboarding is complete on the server with the edited answer", JSON.stringify(done.json.profile) + "\n        PUTs: " + puts.join(" | "));
    await closeApp(app);
    ({ app, win } = await launch(userData));
    await sleep(3500);
    ok(!(await win.locator("[data-testid=onboarding]").count()), "next launch opens ORVYN directly");
    ok(/Welcome back, Royce\./.test(await win.locator("body").innerText()), "the home screen: “Welcome back, Royce.”");
    ok(await win.locator("[data-testid=home-quick-actions]").isVisible().catch(() => false), "quick actions: New Project, Open Project, Browse Files, Connect Server");
    await shot(win, "17-desktop-home");
    await closeApp(app);

    console.log("\n8. Web → desktop handoff");
    const web = await api("/auth/register", "POST", { name: "Web User", email: "web@example.com", password: "Started-On-The-Web-1" });
    const webLink = (mails().find((m) => m.to === "web@example.com")?.text.match(/https?:\/\/\S+\/auth\/verify\?token=\S+/) ?? [])[0];
    if (webLink) await fetch(webLink); else console.log("    no web verification link", JSON.stringify(mails().map((m) => m.to)));
    await api("/onboarding/provision", "POST", {}, web.json.token);
    for (const [done2, next, answers] of [["name", "primary_use", { name: "Web User" }], ["primary_use", "goals", { primaryUse: ["research"] }], ["goals", "work_style", { goals: ["research"] }], ["work_style", "response_style", { workStyle: "move_fast" }], ["response_style", "memory", { responseStyle: "balanced" }]]) {
      const put = await api("/onboarding", "PUT", { step: next, completed: [done2], answers }, web.json.token);
      if (put.status !== 200) console.log(`    web PUT ${next}: ${put.status} ${JSON.stringify(put.json).slice(0, 200)}`);
    }
    const webData = join(work, "desktop-after-web");
    mkdirSync(webData, { recursive: true });
    writeFileSync(join(webData, "orvyn-connection.json"), JSON.stringify({ backendUrl: BASE, apiKey: web.json.token }));
    ({ app, win } = await launch(webData));
    ok(await waitStep(win, "memory", 20000), "the desktop app opens the same account at the same step (memory)", String(await step(win)));
    await closeApp(app);

    console.log("\n9. Existing installs are not interrupted");
    const oldData = join(work, "existing-install");
    mkdirSync(join(oldData), { recursive: true });
    const proj = join(work, "old-project"); mkdirSync(proj, { recursive: true });
    writeFileSync(join(oldData, "orvyn-connection.json"), JSON.stringify({ backendUrl: BASE, apiKey: "" }));
    writeFileSync(join(oldData, "orvyn-recents.json"), JSON.stringify([proj]));
    ({ app, win } = await launch(oldData));
    await sleep(3500);
    ok(!(await win.locator("[data-testid=onboarding]").count()), "an existing install opens ORVYN directly");
    await closeApp(app);
    app = null;
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
    if (win) await shot(win, "zz-error");
  } finally {
    if (app) await closeApp(app);
    server.kill("SIGKILL"); model.close();
  }
  console.log(`\nScreens: ${shots}`);
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nONBOARDING UI: PASS" : `\nONBOARDING UI: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
