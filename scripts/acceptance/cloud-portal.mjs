// scripts/acceptance/cloud-portal.mjs
//
// ORVYN Cloud portal (apps/web) end to end, in Chromium, against the real
// backend serving the built portal:
//   1. The portal is served with a strict CSP; deep links load the app shell.
//   2. Sign up → finish setup → Home (plan, credits, 5h/7d windows) — and no
//      model vendor or upstream model id anywhere on screen.
//   3. Cloud Chat: a conversation streams, persists, and reopens after reload;
//      AUTO is the default; uploads (image + JSON) are stored with the chat.
//   4. Files: images show real thumbnails, other types their own icons;
//      Preview opens in the right pane and Download saves the file — neither
//      calls a model nor spends credits. HTML previews are sandboxed.
//   5. Projects: create one, chat inside it; the chat and its files belong to it.
//   6. Billing: checkout returns to /billing; the webhook (not the redirect)
//      grants the pack; invoices and the card come from Stripe.
//   7. Credits: when the allowance runs out the chat shows an upgrade prompt.
//   8. Isolation: another account gets 404 for every conversation, file and
//      project of the first — over the API, the chat socket and in the UI.
//
// Usage (after `npm run build -w @orvyn/backend && npm run build -w @orvyn/web`):
//   node scripts/acceptance/cloud-portal.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const PORT = 4871, MODEL_PORT = 4872, STRIPE_PORT = 4873;
const BASE = `http://127.0.0.1:${PORT}`;
const WHSEC = "whsec_portal_test";
const PLATFORM_ID = "nebius:zai-org/GLM-5.3-Flash";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const webDist = join(repoRoot, "apps", "web", "dist");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-portal-data-"));
const fixtures = mkdtempSync(join(tmpdir(), "orvyn-portal-files-"));
const shots = process.env.ORVYN_PORTAL_SHOTS || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const VENDOR = /nebius|fireworks|cheaper ?inference|openrouter|zai-org|GLM|kimi|moonshot|deepseek|qwen|llama|mistral|gemini|anthropic|openai|OVH/i;

// A 2x2 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==", "base64");

// ---- scripted model: echoes; "BIG" reports a huge usage ----
let modelCalls = 0;
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "x" }] })); }
    modelCalls++;
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const users = (body.messages ?? []).filter((m) => m.role === "user");
    const last = textOf(users[users.length - 1]?.content ?? "");
    const big = /BIG/.test(last);
    const usage = big ? { prompt_tokens: 3_000_000, completion_tokens: 10, total_tokens: 3_000_010 } : { prompt_tokens: 40, completion_tokens: 8, total_tokens: 48 };
    const text = `Cloud reply: ${last.slice(0, 80).replace(/\s+/g, " ")}`;
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const part of text.match(/.{1,12}/g)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});

// ---- mock Stripe ----
const stripeCalls = [];
const stripe = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    stripeCalls.push({ method: req.method, url: req.url, body: decodeURIComponent(raw) });
    res.setHeader("Content-Type", "application/json");
    const u = req.url ?? "";
    if (u.startsWith("/v1/customers")) return res.end(JSON.stringify({ id: "cus_portal" }));
    if (u.startsWith("/v1/checkout/sessions")) return res.end(JSON.stringify({ id: `cs_portal_${stripeCalls.length}`, url: "https://checkout.stripe.test/pay" }));
    if (u.startsWith("/v1/billing_portal/sessions")) return res.end(JSON.stringify({ url: "https://billing.stripe.test/portal" }));
    if (u.startsWith("/v1/invoices")) return res.end(JSON.stringify({ data: [{ id: "in_portal_1", created: Math.floor(Date.now() / 1000) - 3600, status: "paid", amount_paid: 1000, lines: { data: [{ description: "10,000 ORVYN credits" }] }, hosted_invoice_url: "https://invoice.stripe.test/i/1", invoice_pdf: "https://invoice.stripe.test/i/1.pdf" }] }));
    if (u.startsWith("/v1/payment_methods")) return res.end(JSON.stringify({ data: [{ card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2031 } }] }));
    if (u.startsWith("/v1/subscriptions")) return res.end(JSON.stringify({ data: [] }));
    res.statusCode = 404; res.end("{}");
  });
});

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text, headers: r.headers };
};
const webhook = async (event) => {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`).digest("hex")}`;
  return fetch(`${BASE}/api/v1/billing/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": sig }, body });
};
/** One chat turn over the socket, as another client would send it. */
async function socketTurn(token, sessionId, text) {
  const { json } = await call("/auth/ws-ticket", "POST", {}, token);
  return new Promise((resolveTurn) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?ticket=${encodeURIComponent(json.ticket)}`);
    let out = ""; let error = null;
    const t = setTimeout(() => { try { ws.close(); } catch {} resolveTurn({ out, error: error ?? "timeout" }); }, 15000);
    ws.onmessage = (ev) => {
      const c = JSON.parse(String(ev.data));
      if (c.type === "connection.ready") return ws.send(JSON.stringify({ task: "chat", surface: "cloud", sessionId, userMessage: text, requestedModelId: "auto", context: { mode: "ask" } }));
      if (c.heartbeat) return;
      if (c.delta) out += c.delta;
      if (c.error) error = c.error;
      if (c.done) { clearTimeout(t); ws.close(); resolveTurn({ out, error }); }
    };
    ws.onerror = () => { clearTimeout(t); resolveTurn({ out, error: "socket error" }); };
  });
}
let current = null;
const shot = async (page, name) => { if (shots) { mkdirSync(shots, { recursive: true }); await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }); } };

async function main() {
  if (!existsSync(join(webDist, "index.html"))) throw new Error("Build the portal first: npm run build -w @orvyn/web");
  writeFileSync(join(fixtures, "photo.png"), PNG);
  writeFileSync(join(fixtures, "data.json"), JSON.stringify({ hello: "portal" }));
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await new Promise((r) => stripe.listen(STRIPE_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-portal-proj-")), PORT: String(PORT),
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_PUBLIC_ORIGIN: BASE, ORVYN_WEB_DIR: webDist,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 5).toString("base64"),
    ORVYN_AUTH_RATE_LIMIT_RPM: "1000", ORVYN_AUTH_SESSION_RATE_LIMIT_RPM: "5000", ORVYN_TENANT_RATE_LIMIT_RPM: "5000",
    STRIPE_SECRET_KEY: "sk_test_portal", STRIPE_WEBHOOK_SECRET: WHSEC, STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
    STRIPE_PRICE_PRO_MONTHLY: "price_pro_m", STRIPE_PRICE_PACK_10K: "price_pack10k",
    ORVYN_DESKTOP_DOWNLOAD_WINDOWS: "https://downloads.example.test/ORVYN-Setup.exe", ORVYN_DESKTOP_VERSION: "1.0.0",
    MODEL_API_KEY: "platform-key", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: PLATFORM_ID, OPENAI_CODE_MODEL: PLATFORM_ID,
  };
  delete env.ORVYN_API_KEY; delete env.NODE_ENV;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "GOOGLE_CLIENT_ID", "GITHUB_CLIENT_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM || (existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  const browser = await chromium.launch({ executablePath });
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Serving");
    const root = await fetch(`${BASE}/`);
    const csp = root.headers.get("content-security-policy") ?? "";
    ok(root.status === 200 && /<div id="root">/.test(await root.text()), "the portal loads at /");
    ok(/script-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && !/unsafe-eval/.test(csp), "…with a strict Content-Security-Policy", csp);
    const deep = await fetch(`${BASE}/chats/sess_anything`);
    ok(deep.status === 200 && /id="root"/.test(await deep.text()), "deep links (/chats/…) load the app shell");
    const apiMiss = await fetch(`${BASE}/api/v1/definitely-not-a-route`);
    ok(!/id="root"/.test(await apiMiss.text()), "API paths are never answered with the app shell");

    console.log("\n2. Sign up and Home");
    const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 }, acceptDownloads: true });
    await ctx.route("https://checkout.stripe.test/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<h1>Stripe Checkout (test)</h1>" }));
    const page = await ctx.newPage();
    current = page;
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") pageErrors.push(`console: ${m.text()}`); });
    const urls = [];
    page.on("framenavigated", (f) => urls.push(f.url()));
    await page.goto(`${BASE}/`);
    await page.getByRole("button", { name: "Create an account" }).click();
    ok(await page.isVisible("[data-testid=oauth-google]") && await page.isVisible("[data-testid=oauth-github]"), "sign-up shows Continue with Google / GitHub (disabled until the server has their keys)");
    await page.fill("#first", "Ada");
    await page.fill("#last", "Lovelace");
    await page.fill("#company", "Analytical Engines");
    await page.fill("#email", "ada@example.com");
    await page.fill("#password", "a-long-password-1");
    await page.fill("#confirm", "a-long-password-1");
    await page.click("[data-testid=auth-submit]");
    ok(/Terms of Service/.test(await page.innerText(".error")), "sign-up requires agreeing to the Terms and Privacy Policy");
    await page.check("[data-testid=accept-terms]");
    await page.click("[data-testid=auth-submit]");
    await page.waitForSelector("[data-testid=finish-setup]", { timeout: 10000 });
    ok(true, "a new account must finish setup before entering (no skipping into the app)");
    await page.click("[data-testid=finish-setup]");
    await page.waitForSelector("text=Welcome back", { timeout: 10000 });
    await page.waitForSelector("[data-testid=stat-plan]", { timeout: 10000 });
    await sleep(600);
    await shot(page, "home");
    ok((await page.textContent("[data-testid=stat-plan]"))?.trim() === "Free", "Home shows the current plan (Free)");
    ok(/2,000 Credits/.test((await page.textContent("[data-testid=credits-pill]")) ?? ""), "the top bar shows the credit balance", await page.textContent("[data-testid=credits-pill]"));
    const homeText = await page.innerText("body");
    const HOME = ["What can I help with?", "Current plan", "Credits available", "5-hour window", "7-day window", "New chat", "New project", "Upload files", "Continue where you left off", "Projects", "Recent files", "Usage", "Download Desktop"];
    for (const label of HOME) if (!homeText.includes(label)) ok(false, `Home shows "${label}"`);
    ok(HOME.every((l) => homeText.includes(l)), "Home has the orb greeting and ask box, plan and usage meters, quick actions, recents and the usage chart");
    ok(await page.isVisible(".home-hero__orb video"), "…with the animated ORVYN orb");
    ok(!VENDOR.test(homeText), "no model vendor or hosting provider appears on Home", (homeText.match(VENDOR) ?? [])[0]);
    const token = await page.evaluate(() => localStorage.getItem("orvyn.session"));
    ok(Boolean(token), "the session is kept in the browser (sent as a header, not a URL)");
    await page.click("[data-testid=model-picker]");
    const menu = await page.innerText(".mp__menu");
    ok(/AUTO/.test(menu) && /Fast/.test(menu) && /Reasoning/.test(menu) && /Code/.test(menu) && /Research/.test(menu) && /Vision/.test(menu), "the model menu lists AUTO, Fast, Reasoning, Code, Research, Vision", menu);
    ok(!VENDOR.test(menu), "…and never a vendor or upstream model id", menu);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 900);

    console.log("\n3. Cloud Chat");
    await page.click("text=Chats >> nth=0");
    await page.waitForURL(/\/chats$/);
    await page.fill("textarea[aria-label=Message]", "Hello portal");
    await page.click("[data-testid=send]");
    await page.waitForURL(/\/chats\/[^/]+$/, { timeout: 10000 });
    await page.waitForFunction(() => /Cloud reply: Hello portal/.test(document.querySelector("[data-testid=chat-stream]")?.textContent ?? ""), null, { timeout: 15000 });
    const chatId = page.url().split("/").pop();
    ok(true, "a message streams a reply and the conversation gets its own URL");
    // Attach an image and a JSON file.
    await page.setInputFiles("[data-testid=file-input]", [join(fixtures, "photo.png"), join(fixtures, "data.json")]);
    await page.fill("textarea[aria-label=Message]", "Look at these files");
    await page.click("[data-testid=send]");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=msg-assistant]")].filter((m) => /Cloud reply:.*Look at these/.test(m.textContent ?? "")).length === 1, null, { timeout: 15000 });
    await page.waitForSelector("[data-testid=chat-stream] img[data-testid=thumb]", { timeout: 10000 });
    ok(true, "attached images show their real thumbnail in the conversation");
    await page.reload();
    await page.waitForFunction(() => /Cloud reply:.*Look at these/.test(document.querySelector("[data-testid=chat-stream]")?.textContent ?? ""), null, { timeout: 10000 });
    const afterReload = await page.innerText("[data-testid=chat-stream]");
    ok(/Hello portal/.test(afterReload) && /Cloud reply: Hello portal/.test(afterReload) && /data\.json/.test(afterReload), "after a reload the whole conversation and its files are still there", afterReload.slice(0, 300));
    const stored = await call(`/sessions/${chatId}/messages`, "GET", null, token);
    ok(stored.json.messages?.length === 4 && stored.json.messages[2]?.meta?.attachments?.length === 2, "the server stored 4 messages, attachments on the user turn", JSON.stringify(stored.json).slice(0, 300));
    const sessRow = (await call("/sessions", "GET", null, token)).json.sessions.find((s) => s.sessionId === chatId);
    ok(sessRow && !sessRow.projectRoot && (sessRow.runIds ?? []).length === 0, "a Cloud chat never starts a Desktop mission (no project root, no runs)", JSON.stringify(sessRow));
    ok(!VENDOR.test(afterReload), "no vendor name in the conversation view");

    console.log("\n4. Files, Preview, Download");
    const before = (await call("/billing", "GET", null, token)).json.wallet;
    const callsBefore = modelCalls;
    await call("/artifacts", "POST", { name: "page.html", kind: "file", content: "<h1 id=x>Hi</h1><script>try{document.title='T:'+String(parent.document.cookie)}catch(e){document.title='blocked'}</script>" }, token);
    await call("/artifacts", "POST", { name: "styles.css", kind: "file", content: "body{color:red}" }, token);
    await call("/artifacts", "POST", { name: "main.ts", kind: "file", content: "export const a = 1;" }, token);
    await call("/artifacts", "POST", { name: "report.pdf", kind: "file", base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), mediaType: "application/pdf" }, token);
    await page.goto(`${BASE}/files`);
    await page.waitForSelector("[data-testid=file-card]");
    await page.waitForSelector("[data-testid=file-card][data-kind=image] img[data-testid=thumb]", { timeout: 10000 });
    ok(true, "an image file card shows its real thumbnail");
    const kinds = await page.$$eval("[data-testid=file-card]", (els) => els.map((e) => [e.getAttribute("data-kind"), e.querySelector(".fileicon")?.textContent ?? "thumb"]));
    const label = (k) => kinds.find(([kind]) => kind === k)?.[1];
    ok(label("html") === "HTML" && label("css") === "CSS" && label("ts") === "TS" && label("json") === "{ }" && label("pdf") === "PDF", "HTML, CSS, TS, JSON and PDF files each have their own icon", JSON.stringify(kinds));
    await shot(page, "files");
    await page.click("[data-testid=file-card][data-kind=image] [data-testid=file-preview]");
    await page.waitForSelector("[data-testid=preview-pane] [data-testid=preview-image]", { timeout: 10000 });
    ok(true, "Preview opens the image in the right-hand pane");
    const dl = page.waitForEvent("download");
    await page.click("[data-testid=preview-pane] >> text=Download");
    const download = await dl;
    const savedPath = await download.path();
    ok(download.suggestedFilename() === "photo.png" && readFileSync(savedPath).equals(PNG), "Download saves the original file", download.suggestedFilename());
    await page.keyboard.press("Escape");
    await page.click("[data-testid=file-card][data-kind=html] [data-testid=file-preview]");
    const frame = await page.waitForSelector("[data-testid=preview-html]");
    ok((await frame.getAttribute("sandbox")) === "allow-scripts", "an HTML preview runs in a sandboxed frame (no same-origin access)");
    await page.waitForFunction(() => /\/api\/v1\/preview\/pvw_/.test(document.querySelector("[data-testid=preview-html]")?.getAttribute("src") ?? ""), null, { timeout: 8000 });
    let pvwTitle = "no frame";
    for (let i = 0; i < 40 && pvwTitle !== "blocked"; i++) {
      const pvw = page.frames().find((f) => /\/api\/v1\/preview\/pvw_/.test(f.url()));
      if (pvw) pvwTitle = await pvw.evaluate(() => document.title).catch(() => "?");
      if (pvwTitle !== "blocked") await sleep(200);
    }
    ok(pvwTitle === "blocked", "…its own scripts run, but it can't reach the portal", pvwTitle);
    const linkUrl = await frame.getAttribute("src");
    ok((await fetch(`${BASE}${linkUrl}`)).status === 200 && (await fetch(`${BASE}/api/v1/preview/pvw_forged`)).status === 404, "the preview link is a capability for that one file (a forged link is 404)");
    const htmlId = (await call("/artifacts", "GET", null, token)).json.artifacts.find((a) => a.name === "page.html").artifactId;
    const htmlResp = await fetch(`${BASE}/api/v1/artifacts/${htmlId}/preview`, { headers: { Authorization: `Bearer ${token}` } });
    ok(/sandbox/.test(htmlResp.headers.get("content-security-policy") ?? "") && htmlResp.headers.get("x-content-type-options") === "nosniff", "…and is served with a CSP sandbox and nosniff");
    await page.keyboard.press("Escape");
    await page.click("[data-testid=file-card][data-kind=json] [data-testid=file-preview]");
    await page.waitForSelector("[data-testid=preview-text]");
    ok(/portal/.test(await page.innerText("[data-testid=preview-text]")), "text files preview as text");
    await page.keyboard.press("Escape");
    const after = (await call("/billing", "GET", null, token)).json.wallet;
    ok(modelCalls === callsBefore && after.availableBalance === before.availableBalance, "Preview and Download never call a model or spend credits", `${callsBefore}->${modelCalls} ${before.availableBalance}->${after.availableBalance}`);

    console.log("\n5. Projects");
    await page.goto(`${BASE}/projects`);
    await page.click("[data-testid=new-project]");
    await page.fill("#pname", "Launch Plan");
    await page.click("[data-testid=create-project]");
    await page.waitForURL(/\/projects\/prj_/, { timeout: 10000 });
    const projectId = page.url().split("/").pop();
    ok(Boolean(await page.waitForFunction(() => document.querySelector("[data-testid=project-name]")?.textContent?.trim() === "Launch Plan", null, { timeout: 8000 }).catch(() => null)), "a new project opens");
    await page.setInputFiles("[data-testid=file-input]", [join(fixtures, "photo.png")]);
    await page.fill("textarea[aria-label=Message]", "Project question");
    await page.click("[data-testid=send]");
    await page.waitForFunction(() => [...document.querySelectorAll("[data-testid=msg-assistant]")].some((m) => /Cloud reply:.*Project question/.test(m.textContent ?? "")), null, { timeout: 15000 });
    await page.waitForURL(/\/projects\/prj_[^/]+\/chats\//, { timeout: 5000 });
    await shot(page, "project");
    const projChats = (await call(`/sessions?projectId=${projectId}`, "GET", null, token)).json.sessions;
    const projFiles = (await call(`/artifacts?projectId=${projectId}`, "GET", null, token)).json.artifacts;
    ok(projChats.length === 1 && projChats[0].projectId === projectId, "the chat belongs to the project", JSON.stringify(projChats));
    ok(projFiles.length === 1 && /^photo(-\d+)?\.png$/.test(projFiles[0].name), "…and so does the file attached in it", JSON.stringify(projFiles.map((f) => f.name)));
    ok(!(await call("/sessions?projectId=" + projectId, "GET", null, token)).json.sessions.some((s) => s.sessionId === chatId), "other chats stay out of the project");

    console.log("\n6. Billing");
    const acct = (await call("/auth/me", "GET", null, token)).json.principal.tenantId;
    await page.goto(`${BASE}/billing`);
    await page.waitForSelector("[data-testid=plan-summary]");
    ok(/Free/.test(await page.innerText("[data-testid=plan-summary]")), "Billing shows the plan and its status");
    await page.click("[data-testid=pack-pack_10k] button");
    await page.waitForURL(/checkout\.stripe\.test/, { timeout: 10000 });
    const co = stripeCalls.filter((c) => c.url === "/v1/checkout/sessions").pop();
    ok(/success_url=http:\/\/127\.0\.0\.1:\d+\/billing\?checkout=success/.test(co?.body ?? ""), "checkout returns to the portal's Billing page", co?.body?.slice(0, 400));
    ok((await call("/billing", "GET", null, token)).json.wallet.purchasedBalance === 0, "going to checkout grants nothing");
    await page.goto(`${BASE}/billing?checkout=success`);
    await page.waitForSelector("[data-testid=checkout-confirming]");
    ok(true, "back from checkout, Billing says it is confirming");
    await webhook({ id: "evt_portal_1", type: "checkout.session.completed", data: { object: { id: "cs_portal_x", mode: "payment", payment_status: "paid", payment_intent: "pi_portal_1", amount_total: 1000, customer: "cus_portal", metadata: { accountId: acct, kind: "topup", packId: "pack_10k" } } } });
    await page.waitForFunction(() => /10,000/.test(document.querySelector("[data-testid=stat-topup]")?.textContent ?? ""), null, { timeout: 15000 });
    ok(true, "the verified webhook grants the pack and the portal shows it");
    await page.goto(`${BASE}/billing`);
    await page.waitForSelector("text=4242", { timeout: 10000 });
    ok(true, "…the card on file (brand and last 4 only)");
    await page.waitForSelector("[data-testid=invoices] >> text=Paid");
    ok(true, "…and invoices from Stripe");
    ok(await page.isVisible("[data-testid=auto-recharge]"), "…and auto-recharge settings");
    await shot(page, "billing");

    console.log("\n7. Out of allowance → upgrade prompt");
    await page.goto(`${BASE}/chats/${chatId}`);
    await page.waitForSelector("[data-testid=msg-assistant]");
    await page.fill("textarea[aria-label=Message]", "BIG job please");
    await page.click("[data-testid=send]");
    await page.waitForFunction(() => (document.querySelector("[data-testid=chat-stream]")?.textContent ?? "").includes("Cloud reply: BIG"), null, { timeout: 15000 });
    await sleep(500);
    await page.fill("textarea[aria-label=Message]", "one more");
    await page.click("[data-testid=send]");
    const prompt = await page.waitForSelector("[data-testid=upgrade-prompt]", { timeout: 15000 }).catch(() => null);
    ok(Boolean(prompt), "when the allowance is used up the chat offers Buy credits / Upgrade", (await page.innerText("[data-testid=chat-stream]")).slice(-300));
    await shot(page, "chat");

    console.log("\n8. Isolation");
    const regB = await call("/auth/register", "POST", { name: "Bob", email: "bob@example.com", password: "a-long-password-2" });
    const B = regB.json.token;
    await call("/onboarding/provision", "POST", {}, B);
    await call("/onboarding", "PUT", { step: "complete", completed: ["first_mission"] }, B);
    const aFile = projFiles[0].artifactId;
    const checks = await Promise.all([
      call(`/sessions/${chatId}`, "GET", null, B), call(`/sessions/${chatId}/messages`, "GET", null, B),
      call(`/artifacts/${aFile}`, "GET", null, B), call(`/artifacts/${aFile}/preview`, "GET", null, B), call(`/artifacts/${aFile}/download`, "GET", null, B),
      call(`/projects/${projectId}`, "GET", null, B),
    ]);
    ok(checks.every((c) => c.status === 404), "another account gets 404 for the first account's chat, messages, files and project", checks.map((c) => c.status).join(","));
    const listsB = await Promise.all([call("/sessions", "GET", null, B), call("/artifacts", "GET", null, B), call("/projects", "GET", null, B), call(`/sessions?projectId=${projectId}`, "GET", null, B), call(`/artifacts?projectId=${projectId}`, "GET", null, B)]);
    ok(listsB[0].json.sessions.length === 0 && listsB[1].json.artifacts.length === 0 && listsB[2].json.projects.length === 0 && listsB[3].json.sessions.length === 0 && listsB[4].json.artifacts.length === 0, "…and sees none of them in any list");
    const cross = await call("/sessions", "POST", { title: "x", projectId }, B);
    ok(cross.status === 404, "…can't start a chat in the first account's project", `${cross.status}`);
    const up = await call("/artifacts", "POST", { name: "x.txt", kind: "upload", content: "x", chatId }, B);
    ok(up.status === 404, "…can't upload into the first account's conversation", `${up.status}`);
    const sock = await socketTurn(B, chatId, "Tell me what you know");
    const aMsgs = (await call(`/sessions/${chatId}/messages`, "GET", null, token)).json.messages;
    ok(!aMsgs.some((m) => /Tell me what you know/.test(m.content)) && !/Hello portal/.test(sock.out), "…can't write into or read the first account's conversation over the chat socket", JSON.stringify(sock));
    const t1 = (await call("/auth/ws-ticket", "POST", {}, B)).json.ticket;
    const reuse = await new Promise((r) => { let n = 0; const open = () => { const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat?ticket=${t1}`); ws.onmessage = (e) => { if (JSON.parse(String(e.data)).type === "connection.ready") { ws.close(); if (++n === 1) open(); else r("reused"); } }; ws.onclose = (e) => { if (n === 1 && e.code !== 1000 && e.code !== 1005) r("refused"); }; ws.onerror = () => { if (n === 1) r("refused"); }; }; open(); setTimeout(() => r(n === 1 ? "refused" : "timeout"), 4000); });
    ok(reuse === "refused", "a chat-socket ticket works once", reuse);
    const pageB = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
    await pageB.goto(`${BASE}/`);
    await pageB.evaluate((t) => localStorage.setItem("orvyn.session", t), B);
    await pageB.goto(`${BASE}/chats/${chatId}`);
    await pageB.waitForSelector("text=That conversation isn't available.", { timeout: 10000 }).catch(() => null);
    const bText = await pageB.innerText("body");
    ok(!/Hello portal/.test(bText) && !/Cloud reply/.test(bText), "in the portal, the other account sees nothing of that conversation");
    await pageB.goto(`${BASE}/projects/${projectId}`);
    ok(Boolean(await pageB.waitForSelector("[data-testid=project-missing]", { timeout: 10000 }).catch(() => null)), "…and 'Project not found' for the project");
    const bHome = await pageB.goto(`${BASE}/`).then(() => pageB.waitForSelector("[data-testid=stat-plan]", { timeout: 10000 })).then(() => pageB.innerText("body"));
    ok(!/Launch Plan|photo\.png|Hello portal/.test(bHome), "…and its Home shows none of the first account's projects, chats or files");

    console.log("\n9. Other pages");
    for (const [path, want] of [["/usage", "Credits per day"], ["/settings", "Security"], ["/help", "How do credits work?"], ["/download", "Download for Windows"]]) {
      await page.goto(`${BASE}${path}`);
      const found = await page.waitForSelector(`text=${want}`, { timeout: 8000 }).catch(() => null);
      ok(Boolean(found), `${path} renders`);
      const txt = await page.innerText("body");
      if (VENDOR.test(txt)) ok(false, `${path} shows no vendor`, (txt.match(VENDOR) ?? [])[0]);
    }
    await shot(page, "download");

    console.log("\n10. Search, chat actions and sharing");
    await page.goto(`${BASE}/`);
    await page.waitForSelector("[data-testid=stat-plan]");
    await page.keyboard.press("Control+k");
    await page.waitForSelector("[data-testid=palette]");
    await page.fill("[data-testid=palette-input]", "Hello portal");
    await sleep(300); await shot(page, "palette");
    await page.waitForSelector("[data-testid=palette-item] >> text=Hello portal", { timeout: 5000 });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForURL(new RegExp(`/chats/${chatId}$`), { timeout: 8000 });
    ok(true, "Ctrl+K finds a chat by title and opens it");
    await page.waitForSelector("[data-testid=msg-assistant]");
    await page.click("[data-testid=head-share]");
    await page.click("[data-testid=share-create]");
    const shareUrl = (await page.textContent("[data-testid=share-url] code"))?.trim() ?? "";
    ok(/\/share\/orvshr_[0-9a-f]+$/.test(shareUrl), "Share makes a public read-only link", shareUrl);
    const anon = await (await browser.newContext()).newPage();
    await anon.goto(shareUrl.replace(/^https?:\/\/[^/]+/, BASE));
    await anon.waitForSelector("[data-testid=shared-chat] >> text=Cloud reply: Hello portal", { timeout: 8000 });
    const shared = await anon.innerText("body");
    ok(/Hello portal/.test(shared) && !/ada@example\.com/.test(shared) && !(await anon.$("[data-testid=file-chip], img[data-testid=thumb]")), "…anyone with it reads the messages — never the files or the account email");
    await page.click("[data-testid=share-off]");
    await page.keyboard.press("Escape");
    const gone = await fetch(`${BASE}/api/v1/public/shares/${shareUrl.split("/").pop()}`);
    ok(gone.status === 404, "turning sharing off kills the link", `${gone.status}`);
    const ren = await call(`/sessions/${chatId}`, "PATCH", { title: "Renamed chat", pinned: true }, token);
    ok(ren.json.session?.title === "Renamed chat" && ren.json.session?.pinned === true, "chats can be renamed and pinned");
    await page.goto(`${BASE}/chats`);
    await page.waitForSelector(".chats__group >> text=Pinned");
    ok((await page.innerText(".chats__list")).includes("Renamed chat"), "pinned chats are grouped at the top of the list");

    console.log("\n11. Projects: details, move, delete");
    const pd = await call(`/projects/${projectId}`, "PATCH", { name: "Launch Plan v2", description: "Q4 launch" }, token);
    ok(pd.json.project?.name === "Launch Plan v2" && pd.json.project?.description === "Q4 launch", "a project can be renamed and described");
    const mv = await call(`/sessions/${chatId}`, "PATCH", { projectId }, token);
    ok(mv.json.session?.projectId === projectId, "a chat can be moved into a project");
    const mvB = await call(`/sessions/${chatId}`, "PATCH", { projectId }, B);
    ok(mvB.status === 404, "…but not by another account", `${mvB.status}`);
    await page.goto(`${BASE}/projects`);
    await page.waitForSelector("[data-testid=project-card] >> text=Q4 launch");
    await shot(page, "projects");
    ok(true, "project cards show the description and counts");
    const del = await call(`/projects/${projectId}`, "DELETE", null, token);
    const back = (await call("/sessions", "GET", null, token)).json.sessions.filter((x) => x.projectId === projectId);
    ok(del.status === 200 && back.length === 0, "deleting a project keeps its chats (they move back to Chats)", JSON.stringify(back.map((x) => x.sessionId)));
    ok((await call(`/projects/${projectId}`, "GET", null, B)).status === 404, "another account still can't see it");

    console.log("\n12. Account settings");
    await page.goto(`${BASE}/settings/security`);
    await page.fill("#pw-cur", "wrong-password");
    await page.fill("#pw-new", "a-new-password-9");
    await page.fill("#pw-conf", "a-new-password-9");
    await page.click("[data-testid=change-password]");
    ok(/current password/i.test(await page.innerText(".error")), "changing the password needs the current one");
    await page.fill("#pw-cur", "a-long-password-1");
    await page.click("[data-testid=change-password]");
    await page.waitForSelector("text=Password changed", { timeout: 8000 });
    const relog = await call("/auth/login", "POST", { email: "ada@example.com", password: "a-new-password-9" });
    ok(relog.status === 200 && (await call("/auth/me", "GET", null, token)).status === 200, "…the new password works and this browser stays signed in");
    await page.goto(`${BASE}/settings/team`);
    await page.waitForSelector("[data-testid=team-members] >> text=ada@example.com");
    await shot(page, "team");
    ok(await page.isVisible("[data-testid=team-upsell]"), "Team shows the members and, on Free, how to get team seats");
    const inv = await call("/account/team/invites", "POST", { email: "bob@example.com" }, token);
    ok(inv.status === 402 && inv.json.code === "SEATS_FULL", "…inviting needs a plan with seats (enforced by the server)", JSON.stringify(inv.json));
    await page.goto(`${BASE}/settings/api-keys`);
    await page.waitForSelector("[data-testid=api-upsell]");
    await shot(page, "apikeys");
    const key = await call("/account/api-keys", "POST", { name: "x" }, token);
    ok(key.status === 402, "API keys need a plan with API access (enforced by the server)", `${key.status}`);
    const forgedKey = await fetch(`${BASE}/api/v1/sessions`, { headers: { Authorization: "Bearer orvkey_forged" } });
    ok(forgedKey.status === 401, "a forged API key is refused", `${forgedKey.status}`);
    await page.goto(`${BASE}/settings`);
    await page.fill("#s-name", "Ada King");
    await page.click("[data-testid=save-profile]");
    await page.waitForFunction(() => /Ada King/.test(document.querySelector("[data-testid=me-name]")?.textContent ?? ""), null, { timeout: 8000 });
    ok(true, "the profile name saves and shows in the top bar");

    console.log("\n13. Notifications and invitations");
    await page.goto(`${BASE}/`);
    await page.waitForSelector("[data-testid=stat-plan]");
    await page.click("[data-testid=bell]");
    await page.waitForSelector("[data-testid=notifications]");
    const notes = await page.innerText("[data-testid=notifications]");
    ok(/allowance|Credits|caught up/.test(notes), "the bell opens real account notifications", notes.slice(0, 200));
    await page.keyboard.press("Escape");
    await page.goto(`${BASE}/invite?token=orvinv_bogus`);
    await page.waitForSelector("text=Invitation unavailable", { timeout: 8000 });
    ok(true, "a bad invitation link says so");
    await page.evaluate(() => sessionStorage.clear());
    await shot(page, "settings");
    if (shots) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${BASE}/`); await page.waitForSelector("[data-testid=stat-plan]"); await sleep(400); await shot(page, "mobile-home");
      await page.goto(`${BASE}/chats/${chatId}`); await page.waitForSelector("[data-testid=msg-assistant]"); await sleep(400); await shot(page, "mobile-chat");
      await page.setViewportSize({ width: 1680, height: 1050 });
    }

    ok(!urls.some((u) => /orvsess_|token=orvsess/.test(u)), "no session token ever appears in a page URL");
    // The wrong-password and bad-invite checks above get their expected 400 / 410 on purpose.
    const unexpected = pageErrors.filter((e) => !/Failed to load resource: the server responded with a status of (400|410)/.test(e));
    ok(unexpected.length === 0, "no uncaught errors in the portal", unexpected.join(" | "));
    await page.click("[data-testid=me-name]");
    await page.click("[data-testid=sign-out]");
    await page.waitForSelector("[data-testid=auth-submit]");
    ok((await call("/auth/me", "GET", null, token)).status === 401, "Sign out ends the session on the server");
  } catch (err) {
    ok(false, "portal run", err?.stack ?? String(err));
    if (current) { console.log("  page:", current.url(), "\n", (await current.innerText("body").catch(() => "")).slice(0, 800)); await shot(current, "failure").catch(() => undefined); }
  } finally {
    await browser.close().catch(() => undefined);
    server.kill();
    model.close(); stripe.close();
    if (failures) console.log(log.join("").slice(-3000));
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll cloud portal checks passed");
  process.exit(failures ? 1 : 0);
}

main();
