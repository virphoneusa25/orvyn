// scripts/acceptance/session-restore.mjs
//
// Phase 3: restore the complete WorkSession and continue the SAME project.
//
// In the real ORVYN Desktop (Electron under Xvfb) with its local engine:
//   1. ORVYN is on project site-a; "Build a small landing page" writes
//      index.html + style.css and publishes a live preview.
//   2. ORVYN is closed completely (app killed, engine stopped), its chat
//      cache emptied, and it reopens on a DIFFERENT project (other-b).
//   3. Chats → open the conversation.
// PASS only if the workspace switches back to site-a, the run's stream is
// back, the session's files are listed, the preview (still served after the
// restart) opens in the Workbench, and a follow-up runs in site-a — not in
// other-b — in the same session, with the earlier work as history.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/session-restore.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4731, MODEL_PORT = 4732;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "session-restore-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-srest-"));
const userData = join(work, "userData");
const projectA = join(work, "site-a");
const projectB = join(work, "other-b");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-srest-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-srest-projects-"));
const OUT = process.env.OUT_DIR || work;

const B1 = "Build a small landing page: index.html and style.css";
const B2 = "Add a footer to index.html";
const HTML1 = `<!doctype html><html><head><title>Site A</title><link rel="stylesheet" href="style.css"></head><body><h1>Welcome to Site A</h1><p>A small landing page built by ORION, restored with its whole work session.</p></body></html>`;
const HTML2 = HTML1.replace("</body>", "<footer>Made with ORVYN</footer></body>");
const CSS = "body { font-family: sans-serif; }\nh1 { color: #333; }\n";

const requests = [];
function toolResults(msgs) {
  const asked = msgs.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
  return msgs.filter((m) => m.role === "tool").map((m) => {
    const call = asked.find((c) => c.id === m.tool_call_id);
    let args = {}; try { args = JSON.parse(call?.function?.arguments ?? "{}"); } catch {}
    return { name: call?.function?.name, args, content: String(m.content ?? "") };
  });
}
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  if (system.includes("ORVYN VERIFIER")) {
    const url = (system.match(/Published page: (\S+)/) ?? [])[1];
    const n = toolResults(msgs).length;
    if (url && n === 0) return { text: "", call: { name: "browser_open", args: { url } } };
    if (url && n === 1) return { text: "", call: { name: "browser_console_errors", args: {} } };
    return { text: "VERDICT: PASS\n- The page loads its stylesheet with no errors." };
  }
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const last = String(msgs[lastUserIdx]?.content ?? "");
  const since = toolResults(msgs.slice(lastUserIdx));
  if (!since.length) requests.push({ last, messages: msgs.map((m) => String(m.content ?? "")) });
  if (!tools.length) return { text: "OK." };
  const wrote = (p) => since.some((r) => r.name === "write_file" && r.args.path === p);
  if (last.includes(B1)) {
    if (!wrote("index.html")) return { text: "Building the page.", call: { name: "write_file", args: { path: "index.html", content: HTML1 } } };
    if (!wrote("style.css")) return { text: "", call: { name: "write_file", args: { path: "style.css", content: CSS } } };
    return { text: "Built the landing page: index.html loads style.css." };
  }
  if (last.includes(B2)) {
    if (!wrote("index.html")) return { text: "Adding the footer.", call: { name: "write_file", args: { path: "index.html", content: HTML2 } } };
    return { text: "Added a footer to index.html." };
  }
  return { text: "Done." };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
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
// Local engine, no account: the same (default) tenant the desktop uses.
const H = { "Content-Type": "application/json" };
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


function startBackend(env, log) {
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  return server;
}
async function healthy() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return true; } catch {} await sleep(250); }
  return false;
}
async function launchApp() {
  const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env } });
  const win = await app.firstWindow();
  win.on("console", (m) => { if (process.env.DEBUG) console.log("[renderer]", m.type(), m.text().slice(0, 300)); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.setPosition(0, 0); });
  await win.waitForSelector("text=Run mission", { timeout: 30_000 });
  return { app, win };
}
const chatFile = () => { try { return JSON.parse(readFileSync(join(userData, "orvyn-chats.json"), "utf8")); } catch { return null; } };


async function settle(win, n) {
  return waitFor(async () => {
    const r = ((await api("/agent/stream/runs")).json.runs ?? []).sort((a, b) => a.createdAt - b.createdAt);
    if (r.some((x) => x.status === "awaiting_approval")) {
      const allow = win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).first();
      if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
    }
    return r.length >= n && r.slice(0, n).every((x) => ["completed", "error", "cancelled"].includes(x.status)) ? r : null;
  }, 120_000, 400);
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const log = [];
  let server = startBackend(env, log);
  let app, win;
  const bodyText = () => win.locator("body").innerText();
  try {
    ok(await healthy(), "ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(projectA, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([projectA]));
    ({ app, win } = await launchApp());
    ok(/site-a/.test(await bodyText()), "ORVYN opened on project site-a");

    // 1. Build something in site-a.
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(B1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    const r1 = await settle(win, 1);
    const ev1 = r1?.[0] ? ((await api(`/agent/stream/runs/${r1[0].id}/events.json`)).json.events ?? []) : [];
    ok(r1?.[0]?.status === "completed", "1. the landing page was built in site-a", JSON.stringify(ev1.filter((e) => /error|fail|blocked|verification|gate/.test(e.type)).map((e) => [e.type, JSON.stringify(e.data).slice(0, 300)])));
    const sessionId = ((await api("/sessions")).json.sessions ?? [])[0]?.sessionId;
    const st1 = (await api(`/sessions/${sessionId}/state`)).json;
    ok(JSON.stringify(st1.files?.map((f) => f.path)) === JSON.stringify(["index.html", "style.css"]), "1. the session lists the files it changed", JSON.stringify(st1.files));
    ok(Boolean(st1.preview?.url) && st1.preview.available, "1. the session has a live preview", JSON.stringify(st1.preview));
    const previewUrl = st1.preview?.url;

    // 2. Close ORVYN completely; it comes back on ANOTHER project, with no chat cache.
    process.kill(app.process().pid, "SIGKILL"); app = undefined;
    server.kill("SIGTERM"); await new Promise((r) => server.once("exit", r));
    writeFileSync(join(userData, "orvyn-chats.json"), JSON.stringify({ sessions: [] }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([projectB, projectA]));
    server = startBackend(env, log);
    ok(await healthy(), "2. the engine restarted");
    const served = await fetch(previewUrl.replace(/^https?:\/\/[^/]+/, BASE)).then(async (r) => ({ status: r.status, text: await r.text() })).catch((e) => ({ status: 0, text: String(e) }));
    ok(served.status === 200 && /Welcome to Site A/.test(served.text), "2. the preview is still served after the restart", `${served.status} ${served.text.slice(0, 120)}`);
    ({ app, win } = await launchApp());
    ok(/other-b/.test(await bodyText()) && !/site-a/.test(await bodyText()), "2. ORVYN reopened on a different project (other-b)");

    // 3. Open the conversation from Chats.
    await win.getByText(/^Chats$/).first().click();
    const row = await waitFor(async () => {
      const r = win.locator(`[data-testid="chat-row"][data-session-id="${sessionId}"]`);
      return (await r.count()) === 1 ? r : null;
    }, 20_000, 300);
    ok(!!row, "3. Chats lists the conversation");
    await row.click();
    ok(!!(await waitFor(async () => /site-a/.test(await bodyText()) && !/other-b ▾/.test(await bodyText()), 15_000, 300)), "3. the workspace switched back to the session's project (site-a)");
    ok(!!(await waitFor(async () => /Built the landing page: index\.html loads style\.css\./.test(await bodyText()), 15_000, 300)), "3. the run's stream is back");
    const card = win.locator('[data-testid="session-restore"]');
    ok(!!(await waitFor(async () => (await card.count()) === 1, 15_000, 300)), "3. the session card is shown");
    ok((await card.getAttribute("data-project-root").catch(() => "")) === projectA, "3. …for site-a");
    const files = await win.locator('[data-testid="session-file"]').allInnerTexts();
    ok(JSON.stringify(files) === JSON.stringify(["index.html", "style.css"]), "3. …listing the files the session changed", JSON.stringify(files));

    // 4. The preview opens in the Workbench.
    await win.locator('[data-testid="session-preview"]').click();
    const siteId = (previewUrl.match(/\/sites\/([^/]+)/) ?? [])[1];
    const h1 = await waitFor(async () => app.evaluate(async ({ webContents }, id) => {
      const b = globalThis.__orvynBrowser;
      const view = b?.workbench.surfaceReport().views.find((v) => v.url.includes(`/sites/${id}`) && v.visible);
      if (!view) return null;
      const wc = webContents.getAllWebContents().find((w) => w.getURL().includes(`/sites/${id}`));
      return wc ? await wc.executeJavaScript("document.querySelector('h1')?.textContent || ''") : null;
    }, siteId), 20_000, 400);
    ok(h1 === "Welcome to Site A", "4. Open preview shows the page in the Workbench Browser", String(h1));
    screen("restore-preview.png");

    // 5. Continue the SAME project: a follow-up runs in site-a, in the same session.
    const box = win.locator("textarea").last();
    await box.click(); await box.fill(B2); await box.press("Enter");
    const r2 = await settle(win, 2);
    ok(r2?.[1]?.status === "completed", "5. the follow-up ran", JSON.stringify(r2?.map((x) => x.status)));
    ok(/<footer>Made with ORVYN<\/footer>/.test(readFileSync(join(projectA, "index.html"), "utf8")), "5. …in site-a (index.html there has the footer)");
    ok(!existsSync(join(projectB, "index.html")), "5. …and nothing was written into other-b");
    const s2 = (await api(`/sessions/${sessionId}`)).json.session;
    ok(s2?.runIds?.length === 2 && s2.runIds[0] === r1?.[0]?.id, "5. …in the same session (2 runs)", JSON.stringify(s2));
    ok(((await api("/sessions")).json.sessions ?? []).length === 1, "5. no second conversation was created");
    const seen = JSON.stringify(requests.find((r) => r.last.includes(B2))?.messages ?? []);
    ok(seen.includes(B1) && /Built the landing page/.test(seen), "5. ORION got the earlier work as history");
    const st2 = (await api(`/sessions/${sessionId}/state`)).json;
    ok(st2.files?.find((f) => f.path === "index.html")?.operation === "write" && st2.preview?.available, "5. the session's files and preview are up to date", JSON.stringify({ files: st2.files, preview: st2.preview }));
    screen("restore-after.png");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("restore-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nSESSION RESTORE: PASS" : `\nSESSION RESTORE: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
