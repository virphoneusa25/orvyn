// scripts/acceptance/work-session.mjs
//
// Phase 1: a durable WorkSession.
//
// In the real ORVYN Desktop (Electron under Xvfb) with its local engine:
//   1. Start ORVYN.  2. Create a chat.  3. Send "Create hello.txt".
//   4. Confirm a sessionId and a runId exist (backend, run, chat).
//   5. Close ORVYN completely (desktop AND engine).
//   6. Reopen ORVYN (the local chat cache is emptied first, so the list can
//      only come from the backend's sessions).
//   7. Open Chats.
// PASS only if the same conversation appears with the same sessionId and runId.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/work-session.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4711, MODEL_PORT = 4712;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "work-session-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-wsess-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-wsess-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-wsess-projects-"));
const OUT = process.env.OUT_DIR || work;

const M1 = "Create hello.txt";

const requests = [];
function nextTurn(body) {
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const toolsSince = msgs.slice(lastUserIdx).filter((m) => m.role === "tool");
  const last = String(msgs[lastUserIdx]?.content ?? "");
  requests.push(last);
  if (!tools.length) return { text: "OK." };
  if (last.includes(M1)) return toolsSince.length ? { text: "Created hello.txt." } : { text: "Creating hello.txt.", call: { name: "write_file", args: { path: "hello.txt", content: "Hello" } } };
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
  try {
    ok(await healthy(), "1. ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    ({ app, win } = await launchApp());
    ok(true, "1. ORVYN Desktop started");

    // 2. Create a chat (New task), 3. send "Create hello.txt"
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(M1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    const runs = async () => ((await api("/agent/stream/runs")).json.runs ?? []);
    const done = await waitFor(async () => {
      const r = await runs();
      if (r.some((x) => x.status === "awaiting_approval")) {
        const allow = win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).first();
        if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
      }
      return r.length >= 1 && ["completed", "error", "cancelled"].includes(r[0].status) ? r : null;
    }, 90_000, 400);
    ok(done?.[0]?.status === "completed", "3. \"Create hello.txt\" ran and completed", JSON.stringify(done?.map((x) => ({ id: x.id, status: x.status }))));
    const runId = done?.[0]?.id;

    // 4. sessionId + runId exist: in the backend, and on the chat
    const list1 = (await api("/sessions")).json.sessions ?? [];
    const s1 = list1.find((s) => s.runIds?.includes(runId));
    ok(list1.length === 1 && !!s1?.sessionId, `4. the backend has one WorkSession owning the run (${s1?.sessionId} → ${runId})`, JSON.stringify(list1));
    ok(s1?.activeRunId === runId && !!s1?.workspaceId && !!s1?.projectId, "4. …with its active run, workspace and project", JSON.stringify(s1));
    const ev = (await api(`/agent/stream/runs/${runId}/events.json`)).json.events ?? [];
    ok(ev.some((e) => e.type === "run.session" && e.data?.sessionId === s1?.sessionId), "4. the run records the session it belongs to");
    const sessionId = s1?.sessionId;
    await sleep(800);
    const cached = chatFile()?.sessions?.find((c) => c.sessionId === sessionId);
    ok(cached?.runId === runId, "4. the chat is bound to the same session and run (local cache written)", JSON.stringify(chatFile()?.sessions?.map((c) => ({ id: c.id, sessionId: c.sessionId, runId: c.runId }))));
    screen("session-before.png");

    // 5. Close ORVYN completely: the desktop AND its engine
    await app.close(); app = undefined;
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    ok(true, "5. ORVYN closed completely (desktop and engine)");

    // Prove the backend is authoritative: the local chat cache is no longer the source.
    const cache = chatFile();
    writeFileSync(join(userData, "orvyn-chats.json"), JSON.stringify({ sessions: [] }));

    // 6. Reopen ORVYN
    server = startBackend(env, log);
    ok(await healthy(), "6. ORVYN's engine restarted");
    ({ app, win } = await launchApp());
    ok(true, "6. ORVYN Desktop reopened");

    // 7. Open Chats
    await win.locator("nav, aside").getByText(/^Chats$/).first().click().catch(async () => { await win.getByText(/^Chats$/).first().click(); });
    const row = await waitFor(async () => {
      const r = win.locator(`[data-testid="chat-row"][data-session-id="${sessionId}"]`);
      return (await r.count()) === 1 ? r : null;
    }, 20_000, 300);
    ok(!!row, `7. Chats shows the conversation with sessionId ${sessionId}`, await win.locator('[data-testid="chat-row"]').evaluateAll((els) => els.map((e) => e.outerHTML.slice(0, 200)).join("\n")).catch(() => ""));
    const rowRun = row ? await row.getAttribute("data-run-id") : null;
    ok(rowRun === runId, `7. …with the same runId ${runId}`, `got ${rowRun}`);
    const rowText = row ? await row.innerText() : "";
    ok(/Create hello\.txt/.test(rowText), "7. …titled by the same conversation", rowText);
    const rows = await win.locator('[data-testid="chat-row"]').count();
    ok(rows === 1, `7. exactly one conversation (no duplicate chat) (${rows})`);
    screen("session-after-chats.png");

    // And it opens: the run's stream comes back.
    await row.click();
    const reopened = await waitFor(async () => /Created hello\.txt/.test(await win.locator("body").innerText()), 15_000, 300);
    ok(!!reopened, "opening it shows the same run's stream again");
    screen("session-after-open.png");
    const list2 = (await api("/sessions")).json.sessions ?? [];
    ok(list2.length === 1 && list2[0].sessionId === sessionId && list2[0].runIds.join() === runId, "the backend still holds exactly the same session and run", JSON.stringify(list2));
    void cache;

    // A normal reopen (local cache kept): still one conversation, same ids.
    await app.close(); app = undefined;
    ({ app, win } = await launchApp());
    await win.getByText(/^Chats$/).first().click();
    const again = await waitFor(async () => {
      const r = win.locator('[data-testid="chat-row"]');
      return (await r.count()) >= 1 ? r : null;
    }, 20_000, 300);
    await sleep(1500);
    const ids = again ? await again.evaluateAll((els) => els.map((e) => [e.getAttribute("data-session-id"), e.getAttribute("data-run-id")].join("|"))) : [];
    ok(ids.length === 1 && ids[0] === `${sessionId}|${runId}`, "reopening again with the cache kept: still one conversation, same sessionId and runId", JSON.stringify(ids));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message, err.cause ?? "");
    screen("session-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nWORK SESSION: PASS" : `\nWORK SESSION: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
