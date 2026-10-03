// scripts/acceptance/desktop-start.mjs
//
// The Desktop starts from a conversation that has no project workspace.
//   xvfb-run -a node scripts/acceptance/desktop-start.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4811, MODEL_PORT = 4812, SEARCH_PORT = 4813;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "sources-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-dsk-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-dsk-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-dsk-projects-"));
const OUT = process.env.OUT_DIR || work;

const Q = "What does a VoIP wholesale carrier do?";
const search = createServer((req, res) => { res.writeHead(404); res.end(); });
const searches = [];
function nextTurn(body) {
  const msgs = body.messages ?? [];
  if (String(msgs[0]?.content ?? "").includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  return { text: "A wholesale carrier sells call termination to other providers." };
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
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    ({ app, win } = await launchApp());
    // This engine has no Docker; pretend the sandbox runtime exists so the pane tries to start a desktop.
    await win.route("**/api/v1/desktop/session**", async (route) => {
      const req = route.request();
      if (req.method() === "POST") { starts.push(JSON.parse(req.postData() || "{}")); return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "test: no docker" }) }); }
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sandbox: true, session: null }) });
    });
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(Q);
    await win.getByRole("button", { name: /Run mission/ }).click();
    ok(!!(await waitFor(async () => /call termination/.test(await win.locator("body").innerText()), 30_000, 300)), "a chat with no project workspace answered");
    await win.locator('[data-testid="workbench-plus"]').click();
    await win.locator('[data-testid="workbench-plus-menu"]').getByText(/^Desktop$/).click();
    await sleep(1500);
    const body = await win.locator("body").innerText();
    await win.screenshot({ path: join(OUT, "desktop-start.png") }).catch(() => {});
    ok(!/Open a project to start Desktop/.test(body), "the Desktop does not demand a project");
    ok(!!(await waitFor(async () => starts.length > 0 || null, 10_000, 300)) || /Start|Launch|Desktop/.test(body), "the Desktop can start (a start request or a Start button)", JSON.stringify({ starts, tail: body.slice(-400) }));
    const startBtn = win.getByRole("button", { name: /Start( Desktop| session)?|Launch/i }).first();
    if (!starts.length && await startBtn.count()) { await startBtn.click(); await waitFor(async () => starts.length > 0 || null, 8_000, 300); }
    ok(starts.length > 0 && String(starts[0].projectRoot ?? "").length > 0, "starting it asks the engine for a desktop with a workspace name", JSON.stringify(starts));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message); screen("desktop-error.png");
  } finally {
    await app?.close().catch(() => {}); server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- log ---\n" + log.join("").slice(-1200));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nDESKTOP START: PASS" : `\nDESKTOP START: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
