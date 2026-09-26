// scripts/acceptance/advisor.mjs
//
// ORION as an advisor, like the best chat assistants:
//   1. thinking-heavy questions get the advisor style (take a position, go
//      one step further, shape and size the answer to the question);
//   2. they go to the strongest reasoning model; quick ones do not;
//   3. ORION remembers what the user says about themselves and their work,
//      uses it in a NEW conversation, and shows it (editable) in Memory;
//   4. answers have Copy, Read aloud, Share and Regenerate.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/advisor.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4751, MODEL_PORT = 4752;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "advisor-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-adv-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-adv-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-adv-projects-"));
const OUT = process.env.OUT_DIR || work;

const DEEP_Q = "What should we name our foundation model family? We are Kernel AI and we're building an AI co-worker app called ORVYN.";
const NEXT_Q = "What API model ids should they use?";
const QUICK_Q = "What is 2+2?";
const FACT = "Runs Kernel AI, which is building an AI co-worker app called ORVYN.";

const calls = []; // { model, system, last }
let deepAnswers = 0;
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = msgs.filter((m) => m.role === "system").map((m) => String(m.content)).join("\n");
  const last = String([...msgs].reverse().find((m) => m.role === "user")?.content ?? "");
  calls.push({ model: String(body.model ?? ""), system, last });
  if (system.includes("You maintain a short memory")) {
    return { text: last.includes("Kernel AI") ? JSON.stringify({ add: [FACT], update: [], remove: [] }) : '{"add":[],"update":[],"remove":[]}' };
  }
  if (last.includes(DEEP_Q)) {
    deepAnswers++;
    return { text: deepAnswers === 1
      ? "My top three for Kernel AI:\n\n1. **KXM — Kernel Execution Model** — best fit for ORVYN.\n2. **KGM**\n3. **KRM**\n\n```\nKXM-1 Mini\nKXM-1\nKXM-1 Pro\n```"
      : "Regenerated: go with **KXM** — it reads as execution, which is what ORVYN does." };
  }
  if (last.includes(NEXT_Q)) return { text: "Use `kxm-1-mini`, `kxm-1`, `kxm-1-pro`." };
  if (last.includes(QUICK_Q)) return { text: "4." };
  return { text: "OK." };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: ["scripted-agent", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "claude-sonnet-5"].map((id) => ({ id })) })); }
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
    // The certified lanes (fast = GPT-5.6 Luna, premium = GPT-5.6 Sol), served by the scripted model.
    CHEAPER_INFERENCE_API_KEY: "scripted", CHEAPER_INFERENCE_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`,
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const log = [];
  const server = startBackend(env, log);
  let app, win;
  const body = () => win.locator("body").innerText();
  try {
    ok(await healthy(), "ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    ({ app, win } = await launchApp());

    // 1+2. A thinking-heavy question: the strongest reasoning model, in the advisor style.
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(DEEP_Q);
    await win.getByRole("button", { name: /Run mission/ }).click();
    ok(!!(await waitFor(async () => /My top three for Kernel AI/.test(await body()), 30_000, 300)), "1. the naming question was answered");
    const deepCall = calls.find((c) => c.last.includes(DEEP_Q) && !c.system.includes("You maintain a short memory"));
    ok(deepCall?.model === "gpt-5.6-sol", `2. …by the strongest reasoning model (${deepCall?.model})`);
    ok(/senior advisor/.test(deepCall?.system ?? "") && /Take a position/.test(deepCall?.system ?? ""), "1. …with the advisor style (take a position, go one step further, size to the question)");
    ok(!!(await waitFor(async () => (await win.locator("pre").count()) >= 1, 5_000, 200)), "1. the names are in a code block (with Copy)");

    // 3. ORION learned something durable about the user.
    const mem = await waitFor(async () => ((await api("/memory")).json.memories ?? []).find((m) => m.kind === "about_user"), 20_000, 400);
    ok(mem?.content === FACT && mem.source === "learned", "3. ORION remembered what the user said about their work", JSON.stringify(mem));

    // 4. Answer tools under the reply: Read aloud, Share, Regenerate.
    const actions = win.locator('[data-testid="answer-actions"]').last();
    ok((await actions.locator('[data-testid="answer-copy"]').count()) === 1 && (await actions.locator('[data-testid="answer-share"]').count()) === 1, "4. the reply has Copy and Share");
    ok((await actions.locator('[data-testid="answer-speak"]').count()) === 1, "4. …and Read aloud");
    await actions.locator('[data-testid="answer-share"]').click();
    const shared = await app.evaluate(({ clipboard }) => clipboard.readText());
    ok(/\*\*Question:\*\* What should we name/.test(shared) && /KXM — Kernel Execution Model/.test(shared), "4. Share copies the question and answer as Markdown", shared.slice(0, 200));
    await actions.locator('[data-testid="answer-regenerate"]').click();
    ok(!!(await waitFor(async () => /Regenerated: go with/.test(await body()) && !/My top three for Kernel AI/.test(await body()), 20_000, 300)), "4. Regenerate replaces the reply with a new one");
    await sleep(800);
    const sessions = (await api("/sessions")).json.sessions ?? [];
    const msgs = (await api(`/sessions/${sessions[0]?.sessionId}/messages`)).json.messages ?? [];
    ok(msgs.length === 2 && msgs[0].role === "user" && /Regenerated/.test(msgs[1].content), "4. …in the stored conversation too (one question, one reply)", JSON.stringify(msgs.map((m) => [m.role, m.content.slice(0, 30)])));
    await win.screenshot({ path: join(OUT, "advisor-chat.png") }).catch(() => {});

    // 3. A NEW conversation already knows the user.
    await win.getByRole("button", { name: /^New$/ }).first().click().catch(async () => { await win.keyboard.press("Control+L"); });
    await sleep(500);
    const box = win.locator("textarea").last();
    await box.click(); await box.fill(NEXT_Q); await box.press("Enter");
    ok(!!(await waitFor(async () => /kxm-1-mini/.test(await body()), 20_000, 300)), "3. a new conversation was answered");
    const nextCall = calls.filter((c) => c.last.includes(NEXT_Q) && !c.system.includes("You maintain a short memory")).pop();
    ok(nextCall?.system.includes(FACT), "3. …and its prompt already includes what ORION knows about the user");

    // 2. A quick question stays on the fast model.
    await box.click(); await box.fill(QUICK_Q); await box.press("Enter");
    await waitFor(async () => calls.some((c) => c.last.includes(QUICK_Q)), 15_000, 200);
    const quick = calls.find((c) => c.last.includes(QUICK_Q));
    ok(quick && quick.model !== "gpt-5.6-sol", `2. a quick question does not use the premium model (${quick?.model})`);

    // 3. The Memory panel shows it under "About you", editable.
    await win.getByText(/^Memory$/).first().click();
    const item = win.locator('[data-testid="memory-item"][data-kind="about_user"]');
    ok(!!(await waitFor(async () => (await item.count()) === 1, 10_000, 300)), "3. Memory → About you lists it");
    ok(/Learned from your conversations/.test(await item.innerText()), "3. …labelled as learned");
    await item.getByRole("button", { name: "Edit" }).click();
    await item.locator("textarea").fill("Runs Kernel AI (KXM models) and builds ORVYN.");
    await item.getByRole("button", { name: "Save" }).click();
    const edited = await waitFor(async () => ((await api("/memory")).json.memories ?? []).find((m) => m.kind === "about_user" && m.content.startsWith("Runs Kernel AI (KXM")), 10_000, 300);
    ok(!!edited, "3. …and can be edited");
    await win.screenshot({ path: join(OUT, "advisor-memory.png") }).catch(() => {});
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    await win?.screenshot({ path: join(OUT, "advisor-error.png") }).catch(() => {});
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nADVISOR: PASS" : `\nADVISOR: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
