// scripts/acceptance/files-pane.mjs
//
// After a website build, the Files pane lists the site files.
//   xvfb-run -a node scripts/acceptance/desktop-start.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4821, MODEL_PORT = 4822, SEARCH_PORT = 4823;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "sources-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-fp-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-fp-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-fp-projects-"));
const OUT = process.env.OUT_DIR || work;

const Q = "Build a simple website for virphone, be sure to include some animations, this is a voip wholesale carrier";
const search = createServer((req, res) => { res.writeHead(404); res.end(); });
const searches = [];
const SITE = {
  "index.html": '<!doctype html><html><head><meta charset="utf-8"><title>VirPhone</title><link rel="stylesheet" href="style.css"></head><body><h1 class="fade">VirPhone Wholesale</h1><p>Carrier-grade voice termination.</p><script src="script.js"></script></body></html>',
  "style.css": "body{font-family:sans-serif;background:#0b1020;color:#fff}.fade{animation:f 1s ease-in}@keyframes f{from{opacity:0}to{opacity:1}}",
  "script.js": "document.querySelector('h1').addEventListener('click',()=>{});",
};
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const sys = String(msgs[0]?.content ?? "");
  if (sys.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  if (sys.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Page renders." };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const done = new Set(msgs.filter((m) => m.role === "tool").map((m) => String(m.content)).join("\n").match(/(index\.html|style\.css|script\.js)/g) ?? []);
  if (tools.includes("write_file")) for (const f of Object.keys(SITE)) if (!done.has(f)) return { text: "", call: { name: "write_file", args: { path: f, content: SITE[f] } } };
  return { text: "Built the VirPhone site: index.html, style.css and script.js with a fade-in animation." };
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
  const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env, ORVYN_SKIP_ONBOARDING: "1" } });
  const win = await app.firstWindow();
  win.on("console", (m) => { if (process.env.DEBUG) console.log("[renderer]", m.type(), m.text().slice(0, 300)); });
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.setPosition(0, 0); });
  await win.waitForSelector("text=Run mission", { timeout: 30_000 });
  return { app, win };
}
const chatFile = () => { try { return JSON.parse(readFileSync(join(userData, "orvyn-chats.json"), "utf8")); } catch { return null; } };


async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = { ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent" };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const log = [];
  const server = startBackend(env, log);
  let app, win;
  const starts = [];
  try {
    ok(await healthy(), "ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    ({ app, win } = await launchApp());
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(Q);
    await win.getByRole("button", { name: /Run mission/ }).click();
    ok(!!(await waitFor(async () => {
      const allow = win.getByRole("button", { name: /Allow for Mission/ }).first();
      if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
      const runs = (await api("/agent/stream/runs")).json.runs ?? [];
      return /Wrote\s+script\.js/.test(await win.locator("body").innerText()) && runs.length > 0 && runs.every((r) => ["completed", "error", "cancelled"].includes(r.status));
    }, 150_000, 500)), "the site files were written and the run ended");
    await sleep(1500);
    await win.screenshot({ path: join(OUT, "after-build.png") }).catch(() => {});
    const filesTab = win.getByRole("tab", { name: /^Files/ }).first();
    if (await filesTab.count()) await filesTab.click(); else { await win.locator('[data-testid="workbench-plus"]').click(); await win.locator('[data-testid="workbench-plus-menu"]').getByText(/^File$/).click(); }
    await sleep(1500);
    await win.screenshot({ path: join(OUT, "files-pane.png") }).catch(() => {});
    const pane = await win.locator('[data-testid="workbench-files"]').innerText().catch(() => "");
    ok(/index\.html/.test(pane) && /style\.css/.test(pane) && /script\.js/.test(pane), "the Files pane lists the site files", pane.slice(0, 400));
    ok(!pane.includes(Q.slice(0, 40)), "no bogus file named after the prompt", pane.slice(0, 400));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message); screen("files-error.png");
  } finally {
    await app?.close().catch(() => {}); server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- log ---\n" + log.join("").slice(-1200));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nFILES PANE: PASS" : `\nFILES PANE: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
