// scripts/acceptance/session-messages.mjs
//
// Phase 2: durable messages.
//
// In the real ORVYN Desktop (Electron under Xvfb) with its local engine, one
// conversation: a question (chat), "Create hello.txt" (a run), a follow-up
// question (chat). Then the app is KILLED (no graceful close, no cache flush).
// PASS only if the backend stored every message the moment it happened —
// messageId, sessionId, role, content, createdAt, runId, sequence — and after
// closing everything and emptying the desktop's cache, reopening the chat
// shows the same messages, once each, in order, with the same ids.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/session-messages.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4721, MODEL_PORT = 4722;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "session-messages-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-smsg-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-smsg-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-smsg-projects-"));
const OUT = process.env.OUT_DIR || work;

const Q1 = "What is 2+2?";
const M2 = "Create hello.txt";
const Q3 = "Thanks, what did you create?";

const requests = [];
function nextTurn(body) {
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const toolsSince = msgs.slice(lastUserIdx).filter((m) => m.role === "tool");
  const last = String(msgs[lastUserIdx]?.content ?? "");
  requests.push(last);
  if (last.includes(Q1)) return { text: "2 + 2 = 4." };
  if (last.includes(Q3)) return { text: "I created hello.txt with the text Hello." };
  if (!tools.length) return { text: "OK." };
  if (last.includes(M2)) return toolsSince.length ? { text: "Created hello.txt." } : { text: "Creating hello.txt.", call: { name: "write_file", args: { path: "hello.txt", content: "Hello" } } };
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
    ok(await healthy(), "ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    ({ app, win } = await launchApp());

    // 1. A question (chat), 2. work (a run), 3. a follow-up question (chat) — one conversation.
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(Q1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    ok(!!(await waitFor(async () => /2 \+ 2 = 4\./.test(await win.locator("body").innerText()), 30_000, 300)), "1. the question was answered in the stream");

    const box = () => win.locator("textarea").last();
    await box().click(); await box().fill(M2); await box().press("Enter");
    const runs = async () => ((await api("/agent/stream/runs")).json.runs ?? []);
    const done = await waitFor(async () => {
      const r = await runs();
      if (r.some((x) => x.status === "awaiting_approval")) {
        const allow = win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).first();
        if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
      }
      return r.length >= 1 && ["completed", "error", "cancelled"].includes(r[0].status) ? r : null;
    }, 90_000, 400);
    ok(done?.[0]?.status === "completed", "2. \"Create hello.txt\" ran in the same conversation");
    const runId = done?.[0]?.id;

    await box().click(); await box().fill(Q3); await box().press("Enter");
    ok(!!(await waitFor(async () => /I created hello\.txt with the text Hello\./.test(await win.locator("body").innerText()), 30_000, 300)), "3. the follow-up question was answered");

    // Kill the app at once: no close handler, no cache flush.
    const pid = app.process().pid;
    process.kill(pid, "SIGKILL");
    app = undefined;
    ok(true, "ORVYN Desktop was killed (no graceful close)");

    // The backend has every message, one by one, in order.
    const sessions = (await api("/sessions")).json.sessions ?? [];
    ok(sessions.length === 1, `one session (${sessions.length})`, JSON.stringify(sessions));
    const sessionId = sessions[0]?.sessionId;
    const msgs = (await api(`/sessions/${sessionId}/messages`)).json.messages ?? [];
    const shape = msgs.map((m) => [m.sequence, m.role, m.content.slice(0, 40), m.runId ? "run" : "chat"]);
    const want = [
      [1, "user", Q1, "chat"],
      [2, "assistant", "2 + 2 = 4.", "chat"],
      [3, "user", M2, "run"],
      [4, "assistant", "Created hello.txt.", "run"],
      [5, "user", Q3, "chat"],
      [6, "assistant", "I created hello.txt with the text Hello.", "chat"],
    ];
    ok(JSON.stringify(shape) === JSON.stringify(want), "the backend stored all six messages in order (sequence 1-6, roles, run links)", JSON.stringify(shape));
    ok(msgs.every((m) => /^msg_/.test(m.messageId) && m.sessionId === sessionId && m.createdAt > 0) && new Set(msgs.map((m) => m.messageId)).size === 6, "each has its own messageId, the sessionId and a createdAt");
    ok(msgs[2]?.runId === runId && msgs[3]?.runId === runId, "the run's instruction and answer carry its runId");
    ok(msgs.every((m) => m.status === "complete"), "no message is left half-written");

    // Close everything, empty the desktop's cache, reopen.
    server.kill("SIGTERM");
    await new Promise((r) => server.once("exit", r));
    writeFileSync(join(userData, "orvyn-chats.json"), JSON.stringify({ sessions: [] }));
    server = startBackend(env, log);
    ok(await healthy(), "the engine restarted");
    ({ app, win } = await launchApp());
    await win.getByText(/^Chats$/).first().click();
    const row = await waitFor(async () => {
      const r = win.locator(`[data-testid="chat-row"][data-session-id="${sessionId}"]`);
      return (await r.count()) === 1 ? r : null;
    }, 20_000, 300);
    ok(!!row && /6 msg/.test(await row.innerText()), "Chats shows the conversation with its 6 messages", row ? await row.innerText() : "");
    await row.click();
    const shown = await waitFor(async () => {
      const text = await win.locator("body").innerText();
      // Each one after the previous (the page header also shows the run's title).
      let from = 0;
      const at = [Q1, "2 + 2 = 4.", M2, "Created hello.txt.", Q3, "I created hello.txt with the text Hello."].map((s) => { const i = text.indexOf(s, from); if (i >= 0) from = i + s.length; return i; });
      return at.every((x) => x >= 0) ? at : null;
    }, 20_000, 300);
    const lastText = await win.locator("body").innerText();
    ok(!!shown, "reopened: the stream shows all six messages in order", JSON.stringify([Q1, "2 + 2 = 4.", M2, "Created hello.txt.", Q3, "I created hello.txt with the text Hello."].map((s) => lastText.indexOf(s))) + "\n" + lastText.slice(0, 1500));
    screen("messages-after.png");
    const pills = await win.locator(".user-pill").allInnerTexts();
    ok(pills.filter((p) => p.includes(M2)).length === 1 && pills.filter((p) => p.includes(Q1)).length === 1, "each message appears once (no duplicate bubbles)", JSON.stringify(pills));
    await sleep(1200);
    const cached = chatFile()?.sessions?.find((c) => c.sessionId === sessionId);
    ok(JSON.stringify((cached?.messages ?? []).map((m) => m.id)) === JSON.stringify(msgs.map((m) => m.messageId)), "the desktop's copy has the same message ids, in the same order", JSON.stringify(cached?.messages?.map((m) => m.id)));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("messages-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nSESSION MESSAGES: PASS" : `\nSESSION MESSAGES: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
