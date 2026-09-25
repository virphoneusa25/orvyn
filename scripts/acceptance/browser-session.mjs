// scripts/acceptance/browser-session.mjs
//
// BrowserSession acceptance — ORION and the visible Workbench Browser share
// ONE browser session.
//
// Runs the real pieces together:
//   * the backend as the ORVYN Cloud control plane (cloud mode),
//   * the real ORVYN Desktop (Electron main + renderer) under Xvfb, which
//     starts its own Local Worker exactly as the installed app does,
//   * a scripted model that asks ORION to:
//       1. browser_open example.com
//       2. browser_set_viewport mobile
//       3. browser_screenshot
//
// The model waits between steps so the harness can check the app itself:
//   after 1: the Workbench Browser visibly shows example.com, in the tab the
//            session owns, and ORION's tool result names the same
//            browserSessionId the Workbench shows;
//   after 2: the same session's visible view resized to the mobile width and
//            the page lays out at 390 CSS px;
//   after 3: the screenshot record belongs to that same browserSessionId.
// Nothing here uses an HTTP fetch of the page as proof.
//
// This sandbox cannot reach the internet, so example.com is served locally
// (a copy of the page with its own responsive CSS) and Chromium maps
// example.com to it (--host-resolver-rules, test-only certificate). On a
// normal machine the same run opens the real example.com.
//
// Usage (after `npm run build -w @orvyn/backend` and `npm run build -w @orvyn/desktop`):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/browser-session.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4681, MODEL_PORT = 4682, SITE_PORT = 4683;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "browser-session-key-00000000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-browser-session-"));
const userData = join(work, "userData");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-bs-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-bs-projects-"));
const OUT = process.env.OUT_DIR || work;

// ---- example.com, served locally --------------------------------------------
const EXAMPLE = `<!doctype html>
<html><head><title>Example Domain</title><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
body{background:#f0f0f2;margin:0;padding:0;font-family:-apple-system,system-ui,"Segoe UI","Open Sans","Helvetica Neue",Helvetica,Arial,sans-serif}
div{width:600px;margin:5em auto;padding:2em;background:#fdfdff;border-radius:.5em;box-shadow:2px 3px 7px 2px rgba(0,0,0,.02)}
a:link,a:visited{color:#38488f;text-decoration:none}
@media (max-width:700px){div{margin:0 auto;width:auto}}
</style></head>
<body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission.</p><p><a href="https://www.iana.org/domains/example">More information...</a></p></div></body></html>`;

function makeCert() {
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(work, "key.pem"), "-out", join(work, "cert.pem"), "-days", "1", "-subj", "/CN=example.com", "-addext", "subjectAltName=DNS:example.com"], { stdio: "ignore" });
  return { key: readFileSync(join(work, "key.pem")), cert: readFileSync(join(work, "cert.pem")) };
}

// ---- scripted model, one step per turn, paused between steps -----------------
const gates = [];
const gate = (i) => (gates[i] ??= (() => { let open; const p = new Promise((r) => (open = r)); return { p, open }; })());
const toolResults = [];
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const results = msgs.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
  const n = results.length;
  if (n === 0) return { text: "Opening example.com in the Workbench Browser.", call: { name: "browser_open", args: { url: "example.com" } } };
  const sid = (results[0].match(/browserSessionId: (\S+)/) ?? [])[1];
  if (n === 1) return { text: "Switching to a mobile viewport.", call: { name: "browser_set_viewport", args: { preset: "mobile", sessionId: sid } } };
  if (n === 2) return { text: "Taking a screenshot.", call: { name: "browser_screenshot", args: { sessionId: sid } } };
  const shot = (results[2].match(/Screenshot: (\S+)/) ?? [])[1];
  return { text: `Done. example.com is open in the Workbench Browser (session ${sid}), resized to mobile, and screenshot ${shot} belongs to that session.` };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const n = (body.messages ?? []).filter((m) => m.role === "tool").length;
    if ((body.tools ?? []).length && n > 0) await gate(n).p; // the harness checks the app before ORION continues
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }] }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.end("data: [DONE]\n\n");
  });
});

// ---- helpers -------------------------------------------------------------------
const H = { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY };
const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function waitFor(fn, ms = 20_000, every = 200) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) { last = await fn(); if (last) return last; await sleep(every); }
  return last;
}

function screen(name) {
  const file = join(OUT, name);
  try { execFileSync("import", ["-window", "root", file], { stdio: "ignore" }); return file; } catch { return null; }
}

async function main() {
  const tls = makeCert();
  const site = createHttpsServer(tls, (req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(EXAMPLE); });
  await new Promise((r) => site.listen(SITE_PORT, "127.0.0.1", r));
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));

  const env = {
    ...process.env,
    ORVYN_CLOUD_MODE: "true", ORVYN_PROJECTS_DIR: projectsDir, ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_API_KEY: API_KEY, ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let app;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    // The desktop app, connected to that control plane like a signed-in user.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: BASE, apiKey: API_KEY }));
    app = await _electron.launch({
      executablePath: electronBin,
      args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", `--host-resolver-rules=MAP example.com:443 127.0.0.1:${SITE_PORT}`, "--ignore-certificate-errors", "--no-proxy-server"],
      env: { ...process.env },
    });
    const win = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.setPosition(0, 0); });
    await win.waitForSelector("text=Run mission", { timeout: 30_000 }).catch(() => {});
    const workerUp = await waitFor(async () => (await api("/local-worker/health")).json.state === "ready", 30_000, 500);
    ok(Boolean(workerUp), "the desktop's Local Worker is connected to the control plane");
    screen("0-before.png");

    const report = () => app.evaluate(() => {
      const b = globalThis.__orvynBrowser;
      return { sessions: b.sessions.list(), surface: b.workbench.surfaceReport() };
    });
    const pageSize = (tabId) => app.evaluate(async ({ webContents }, id) => {
      const b = globalThis.__orvynBrowser;
      const rep = b.workbench.surfaceReport().views.find((v) => v.tabId === id);
      const wc = webContents.getAllWebContents().find((w) => w.getURL().startsWith("https://example.com"));
      if (!wc || !rep) return null;
      return await wc.executeJavaScript("({ w: innerWidth, h: innerHeight, h1: document.querySelector('h1')?.textContent, touch: navigator.maxTouchPoints, mobileUA: /iPhone/.test(navigator.userAgent) })");
    }, tabId);

    // ── ORION: "Open example.com" ─────────────────────────────────────────
    console.log(`\nORION: Open example.com`);
    const started = await api("/agent/stream/runs", "POST", { instruction: "Open example.com, switch to a mobile viewport, and take a screenshot.", executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
    const runId = started.json.runId;
    ok(Boolean(runId), "run starts", JSON.stringify(started.json));
    const events = [];
    let after = 0;
    const pull = async () => {
      const { json } = await api(`/agent/stream/runs/${runId}/events.json?after=${after}`);
      for (const e of json.events ?? []) { events.push(e); after = Math.max(after, Number(e.sequence ?? after)); }
      return json.status;
    };
    const toolDone = (tool) => waitFor(async () => { await pull(); return events.find((e) => (e.type === "tool.completed" || e.type === "tool.failed") && e.data?.tool === tool); }, 40_000, 250);

    const openEv = await toolDone("browser_open");
    ok(openEv?.type === "tool.completed", "browser_open succeeded", JSON.stringify(openEv?.data ?? events.filter((e) => /fail|error/.test(e.type)).map((e) => e.data)).slice(0, 400));
    const orionSid = openEv?.data?.envelope?.structuredData?.browserSessionId;
    ok(/^bs_[0-9a-f]+$/.test(String(orionSid)), `ORION received a browserSessionId (${orionSid})`, JSON.stringify(openEv?.data?.envelope ?? null).slice(0, 400));
    const shown = await waitFor(async () => {
      const r = await report();
      const v = r.surface.views.find((x) => x.sessionId === orionSid);
      return v && v.attached && v.visible && v.url.startsWith("https://example.com") && r.surface.activeId === v.tabId ? { r, v } : null;
    }, 20_000, 300);
    ok(Boolean(shown), "the Workbench Browser visibly shows https://example.com in the session's own tab", JSON.stringify(await report()).slice(0, 600));
    const badge = await waitFor(async () => win.locator('[data-testid="workbench-browser-session"]').getAttribute("data-session-id").catch(() => null), 10_000);
    ok(badge === orionSid, `the Workbench toolbar shows the same session id (${badge})`);
    const title = await waitFor(async () => (await pageSize(shown?.v.tabId))?.h1, 10_000);
    ok(title === "Example Domain", "the visible page is example.com (rendered heading, not a fetch)", String(title));
    ok(shown && shown.v.bounds.width === shown.r.surface.surface?.width, `desktop viewport fills the Workbench surface (${shown?.v.bounds.width}px)`);
    const desktopSize = await pageSize(shown?.v.tabId);
    const shot1 = screen("1-opened.png");
    console.log(`        visible view: ${JSON.stringify(shown?.v.bounds)}  page: ${JSON.stringify(desktopSize)}  screen: ${shot1}`);
    gate(1).open();

    // ── ORION: mobile viewport ──────────────────────────────────────────────
    console.log(`\nORION: Change viewport to mobile`);
    const vpEv = await toolDone("browser_set_viewport");
    ok(vpEv?.type === "tool.completed", "browser_set_viewport succeeded", JSON.stringify(vpEv?.data ?? null).slice(0, 400));
    ok(vpEv?.data?.envelope?.structuredData?.browserSessionId === orionSid, "the resize acted on the same browserSessionId", JSON.stringify(vpEv?.data?.envelope?.structuredData ?? null));
    const resized = await waitFor(async () => {
      const r = await report();
      const v = r.surface.views.find((x) => x.sessionId === orionSid);
      return v && v.visible && v.bounds.width === 390 ? { r, v } : null;
    }, 10_000, 200);
    ok(Boolean(resized), "the user's visible view of that session resized to 390px wide", JSON.stringify((await report()).surface).slice(0, 500));
    ok(resized && resized.v.tabId === shown?.v.tabId, "it is the same tab, not a new browser");
    const mobileSize = await pageSize(resized?.v.tabId);
    ok(mobileSize?.w === 390, `the page lays out at 390 CSS px (was ${desktopSize?.w})`, JSON.stringify(mobileSize));
    ok(mobileSize?.touch > 0 && mobileSize?.mobileUA === true && !desktopSize?.mobileUA, "the page now runs as a mobile device (touch, mobile user agent)", JSON.stringify({ desktopSize, mobileSize }));
    const vpBadge = await win.locator('[data-testid="workbench-browser-session"]').getAttribute("data-viewport").catch(() => null);
    ok(vpBadge === "mobile:390x844", `the Workbench toolbar shows the mobile viewport (${vpBadge})`);
    const sess = (await report()).sessions.find((s) => s.sessionId === orionSid);
    ok(sess?.viewport?.preset === "mobile" && sess?.runId === runId, "the session records viewport mobile and this run", JSON.stringify(sess ?? null).slice(0, 300));
    const shot2 = screen("2-mobile.png");
    console.log(`        visible view: ${JSON.stringify(resized?.v.bounds)}  page: ${JSON.stringify(mobileSize)}  screen: ${shot2}`);
    gate(2).open();

    // ── ORION: screenshot ───────────────────────────────────────────────────
    console.log(`\nORION: Take screenshot`);
    const shotEv = await toolDone("browser_screenshot");
    ok(shotEv?.type === "tool.completed", "browser_screenshot succeeded", JSON.stringify(shotEv?.data ?? null).slice(0, 400));
    const shotData = shotEv?.data?.envelope?.structuredData?.screenshot;
    ok(shotData?.sessionId === orionSid, `the screenshot belongs to ${orionSid}`, JSON.stringify(shotData ?? null));
    const shotEvidence = (shotEv?.data?.envelope?.evidence ?? []).find((e) => e.type === "screenshot");
    ok(shotEvidence?.extra?.sessionId === orionSid, "the tool event's evidence ties the screenshot to the same session", JSON.stringify(shotEv?.data?.envelope?.evidence ?? null));
    const stored = (await report()).sessions.find((s) => s.sessionId === orionSid)?.screenshots ?? [];
    ok(stored.some((s) => s.screenshotId === shotData?.screenshotId && s.sessionId === orionSid), "the desktop session holds that screenshot", JSON.stringify(stored));
    ok(shotData && shotData.width <= 400, `the image is the mobile view (${shotData?.width}×${shotData?.height}px)`);
    const pngB64 = await app.evaluate((_e, id) => globalThis.__orvynBrowser.sessions.image(id)?.toString("base64") ?? null, shotData?.screenshotId);
    if (pngB64) writeFileSync(join(OUT, "3-orion-screenshot.png"), Buffer.from(pngB64, "base64"));
    gate(3).open();

    const status = await waitFor(async () => { const s = await pull(); return ["completed", "error", "cancelled", "blocked"].includes(s) ? s : null; }, 30_000, 300);
    ok(status === "completed", "the run completes", `${status} ${events.filter((e) => /error|blocked/.test(e.type)).map((e) => JSON.stringify(e.data)).join(" | ").slice(0, 300)}`);
    const distinct = new Set(events.map((e) => e.data?.envelope?.structuredData?.browserSessionId).filter(Boolean));
    ok(distinct.size === 1, `every browser tool event used one session (${[...distinct].join(", ")})`);
    const workerLog = existsSync(join(userData, "local-worker.log")) ? readFileSync(join(userData, "local-worker.log"), "utf8") : "";
    const relayed = workerLog.split("\n").filter((l) => l.includes("[local-worker] browser "));
    console.log(`        worker relay: ${relayed.map((l) => l.replace(/.*\[local-worker\] /, "")).join(" | ")}`);
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
  } finally {
    for (let i = 1; i <= 4; i++) gate(i).open();
    await app?.close().catch(() => {});
    server.kill(); model.close(); site.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nBROWSER SESSION: PASS" : `\nBROWSER SESSION: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
