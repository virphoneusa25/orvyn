// scripts/acceptance/chat-handoff-ui.mjs
//
// The chat hands work to a task (start_project_task) and the task really runs.
// In the real ORVYN Desktop with its local engine and a project open:
//   1. A first task runs from Home and completes.
//   2. The user types "?" in the chat. The chat model answers with
//      start_project_task. The app must start a task run in the SAME project,
//      the run must complete, and the chat must stop saying "Preparing…".
//
// Usage: xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/chat-handoff-ui.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4711, MODEL_PORT = 4712;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "conversation-thread-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-handoff-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-handoff-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-handoff-projects-"));
const OUT = process.env.OUT_DIR || work;



const M1 = "Create hello.txt with the text Hello from ORION";
const HANDOFF = "Check the hero section of index.html visually and report any runtime errors";
const seen = { chatOffered: false, taskMessages: [] };

function nextTurn(body) {
  const sys = String(body.messages?.[0]?.content ?? "");
  if (sys.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS" };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const users = msgs.filter((m) => m.role === "user").map((m) => String(m.content));
  const last = users[users.length - 1] ?? "";
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const toolsSince = msgs.slice(lastUserIdx).filter((m) => m.role === "tool");
  if (tools.includes("start_project_task")) {
    seen.chatOffered = true;
    if (toolsSince.length) return { text: "I'm checking the hero in your project now." };
    return { text: "", call: { name: "start_project_task", args: { instruction: HANDOFF } } };
  }
  if (!tools.length) return { text: "OK." };
  if (last.includes(HANDOFF) || users.some((u) => u.includes(HANDOFF))) {
    seen.taskMessages.push(last);
    return toolsSince.length ? { text: "HERO-CHECK-DONE: the hero renders and there are no runtime errors." } : { text: "Reading it.", call: { name: "read_file", args: { path: "hello.txt" } } };
  }
  if (last === M1) return toolsSince.length ? { text: "Created hello.txt." } : { text: "Creating hello.txt.", call: { name: "write_file", args: { path: "hello.txt", content: "Hello from ORION" } } };
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
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  let app;
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }) /* the renderer CSP allows localhost:*, as the installed app uses */);
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    app = await _electron.launch({ executablePath: electronBin, args: [desktopDir, `--user-data-dir=${userData}`, "--no-sandbox", "--no-proxy-server"], env: { ...process.env, ORVYN_SKIP_ONBOARDING: "1" } });
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

    // 1. Home composer: a first task in the project.
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(M1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    const r1 = await settled(1);
    ok(r1?.[0]?.status === "completed", "a first task ran and completed", JSON.stringify(r1));

    // 2. "?" in the chat → the chat hands off → a task must really run.
    const box = win.locator("textarea").last();
    await box.click();
    await box.fill("?");
    await box.press("Enter");
    const handoffShown = await waitFor(async () => (await win.locator('[data-testid="chat-handoff"]').count()) > 0 || (await runs()).length >= 2, 30_000);
    ok(Boolean(handoffShown), "the chat hands the request to a task", String(seen.chatOffered));
    const r2 = await settled(2);
    ok(r2?.length === 2 && r2[1].status === "completed", "the handed-off task started and completed", JSON.stringify((await runs()).map((x) => [x.status, x.instruction?.slice(0, 40)])));
    const firstRoot = r1?.[0]?.projectRoot, secondRoot = (await runs())[1]?.projectRoot;
    ok(Boolean(secondRoot) && secondRoot === firstRoot, "…in the same project", `${firstRoot} vs ${secondRoot}`);
    ok(seen.taskMessages.length > 0, "the task model got the real instruction");
    await sleep(1500);
    const text = await win.locator("body").innerText();
    ok(/HERO-CHECK-DONE/.test(text), "the task's answer is on screen", text.slice(-600));
    const preparing = await win.locator('[data-testid="chat-handoff"]').allInnerTexts();
    ok(preparing.length > 0 && preparing.every((t) => /Started in your project/.test(t)), "the handoff row says the task started (not an endless Preparing…)", JSON.stringify(preparing));
    screen("handoff.png");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("handoff-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nCHAT HANDOFF UI: PASS" : `\nCHAT HANDOFF UI: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
