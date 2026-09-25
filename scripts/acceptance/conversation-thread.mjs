// scripts/acceptance/conversation-thread.mjs
//
// One conversation, one stream.
//
// In the real ORVYN Desktop (Electron under Xvfb) with its local engine, the
// user sends three messages in the same chat:
//   1. "Create hello.txt with the text Hello from ORION"   (Home composer)
//   2. "Now read hello.txt"                                (follow-up)
//   3. "Append a second line Bye to hello.txt"             (follow-up)
// Each follow-up is a new run that continues the previous one. Passes only if:
//   * the stream shows all three messages and all three runs' work, in order,
//     on one screen (earlier runs are not replaced by the newest one);
//   * the backend links the three runs into one thread;
//   * the model's input for message 3 contains messages 1 and 2, what ORION
//     did (from the tool envelopes) and its answers.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/conversation-thread.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4701, MODEL_PORT = 4702;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "conversation-thread-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-thread-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-thread-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-thread-projects-"));
const OUT = process.env.OUT_DIR || work;

const M1 = "Create hello.txt with the text Hello from ORION";
const M2 = "Now read hello.txt";
const M3 = "Append a second line Bye to hello.txt";

// ---- scripted model: acts on the newest user message, remembers requests ----
const requests = [];
function nextTurn(body) {
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const users = msgs.filter((m) => m.role === "user").map((m) => String(m.content));
  const last = users[users.length - 1] ?? "";
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const toolsSince = msgs.slice(lastUserIdx).filter((m) => m.role === "tool");
  if (toolsSince.length === 0) requests.push({ last, messages: msgs.map((m) => ({ role: m.role, content: String(m.content ?? "") })) });
  if (!tools.length) return { text: "OK." };
  if (last === M1) return toolsSince.length ? { text: "Created hello.txt with the text Hello from ORION." } : { text: "Creating hello.txt.", call: { name: "write_file", args: { path: "hello.txt", content: "Hello from ORION" } } };
  if (last === M2) return toolsSince.length ? { text: `hello.txt says: ${String(toolsSince[0].content).trim()}` } : { text: "Reading it.", call: { name: "read_file", args: { path: "hello.txt" } } };
  if (last === M3) return toolsSince.length ? { text: "Added the line Bye. hello.txt now has two lines." } : { text: "Appending the line.", call: { name: "write_file", args: { path: "hello.txt", content: "Hello from ORION\nBye" } } };
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

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    // The desktop's own local engine (the default install): the renderer talks
    // to localhost without an account, and runs execute on this machine.
    ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let app;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }) /* the renderer CSP allows localhost:*, as the installed app uses */);
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env } });
    const win = await app.firstWindow();
    win.on("console", (m) => { if (process.env.DEBUG) console.log("[renderer]", m.type(), m.text().slice(0, 300)); });
    win.on("request", (r) => { if (process.env.DEBUG && r.url().includes("/api/v1/agent")) console.log("[req]", r.method(), r.url()); });
    win.on("response", async (r) => { if (process.env.DEBUG && r.url().includes("/api/v1/agent")) console.log("[res]", r.status(), r.url(), (await r.text().catch(() => "")).slice(0, 300)); });
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(1600, 1000); w.setPosition(0, 0); });
    await win.waitForSelector("text=Run mission", { timeout: 30_000 });

    const runs = async () => ((await api("/agent/stream/runs")).json.runs ?? []).sort((a, b) => a.createdAt - b.createdAt);
    // Default access asks before writing: approve like a user would, in the stream.
    const settled = (n) => waitFor(async () => {
      const r = await runs();
      if (r.some((x) => x.status === "awaiting_approval")) {
        const allow = win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).first();
        if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => {});
      }
      return r.length >= n && r.slice(0, n).every((x) => ["completed", "error", "cancelled"].includes(x.status)) ? r : null;
    }, 90_000, 400);

    // 1. Home composer
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(M1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    const r1 = await settled(1);
    ok(r1?.[0]?.status === "completed", "message 1 ran and completed", JSON.stringify(r1));

    // 2 and 3: the chat's own composer, same conversation
    for (const [i, text] of [[2, M2], [3, M3]]) {
      const box = win.locator("textarea").last();
      await box.click();
      await box.fill(text);
      await box.press("Enter");
      const r = await settled(i);
      ok(r?.length === i && r[i - 1].status === "completed", `message ${i} ran and completed as a follow-up`, JSON.stringify(r?.map((x) => x.status)));
    }
    await sleep(1500);

    // The stream: all three messages and all three runs' work, in order.
    const bubbles = await win.locator(".user-pill").allInnerTexts();
    const order = [M1, M2, M3].map((m) => bubbles.findIndex((b) => b.includes(m)));
    ok(order.every((x) => x >= 0) && order[0] < order[1] && order[1] < order[2], "the stream shows messages 1, 2 and 3 in order", JSON.stringify(bubbles));
    const earlierRuns = await win.locator('[data-testid="thread-run"]').count();
    ok(earlierRuns === 2, `the two earlier runs stay in the stream above the newest one (${earlierRuns})`);
    const text = await win.locator("body").innerText();
    ok(/hello\.txt says: Hello from ORION/.test(text) && /Created hello\.txt/.test(text) && /Added the line Bye/.test(text), "all three answers are on screen together");
    screen("thread.png");

    // The backend session
    const sessions = (await api("/sessions")).json.sessions ?? [];
    const thread = sessions.length === 1 ? (await api(`/sessions/${sessions[0].sessionId}`)).json : {};
    ok(thread.runs?.length === 3 && thread.runs.map((r) => r.instruction).join("|") === [M1, M2, M3].join("|"), "the backend keeps the three runs in one WorkSession", JSON.stringify(thread));

    // What the model saw for message 3
    const req3 = requests.find((r) => r.last === M3);
    const seen = JSON.stringify(req3?.messages ?? []);
    ok(seen.includes(M1) && seen.includes(M2), "for message 3 the model got messages 1 and 2");
    ok(/Wrote hello\.txt/.test(seen) && /Read hello\.txt/.test(seen), "…and what ORION did in each (from the tool envelopes)", seen.slice(0, 600));
    ok(/hello\.txt says: Hello from ORION/.test(seen), "…and ORION's earlier answers");
    ok(readFileSync(join(project, "hello.txt"), "utf8") === "Hello from ORION\nBye", "hello.txt on disk has both lines");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("thread-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nCONVERSATION THREAD: PASS" : `\nCONVERSATION THREAD: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
