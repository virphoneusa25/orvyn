// scripts/acceptance/sources.mjs
//
// "Sources" in the stream: the sites ORION searched and read.
//
// In the real ORVYN Desktop with its local engine, ORION researches with
// web_search (against a local DuckDuckGo-shaped results page: the sandbox has
// no web). PASS only if the run records each result site, the answer has a
// Sources chip with one icon per site and the count, clicking it lists each
// site (title, domain, snippet, the query), and clicking a site opens it in
// the Workbench Browser.
//
// Usage (after building backend and desktop):
//   xvfb-run -a -s "-screen 0 1600x1000x24" node scripts/acceptance/sources.mjs

import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { _electron } from "playwright";

const PORT = 4741, MODEL_PORT = 4742, SEARCH_PORT = 4743;
const BASE = `http://127.0.0.1:${PORT}`;
const API_KEY = "sources-key-0000000000000000";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const desktopDir = join(repoRoot, "apps", "desktop");
const electronBin = join(repoRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const work = mkdtempSync(join(tmpdir(), "orvyn-src-"));
const userData = join(work, "userData");
const project = join(work, "my-project");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-src-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-src-projects-"));
const OUT = process.env.OUT_DIR || work;

// A plain question in Auto mode: the user does NOT pick Research.
const Q = "What is the latest Node.js LTS release?";
const RESULTS = [
  { title: "Node.js Releases", url: "https://nodejs.org/en/about/previous-releases", snippet: "Major Node.js versions enter Active LTS status…" },
  { title: "Node.js — Wikipedia", url: "https://en.wikipedia.org/wiki/Node.js", snippet: "Node.js is a cross-platform JavaScript runtime…" },
];

// A DuckDuckGo-shaped HTML results page, served locally (the sandbox has no web access).
const search = createServer((req, res) => {
  searches.push(decodeURIComponent(String(req.url).split("q=")[1] ?? "").replace(/\+/g, " "));
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(RESULTS.map((r) => `<div><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&rut=x">${r.title}</a><a class="result__snippet" href="#">${r.snippet}</a></div>`).join("\n"));
});
const searches = [];
const modes = [];

function nextTurn(body) {
  const msgs = body.messages ?? [];
  if (String(msgs[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Answer is grounded in the search results." };
  if (String(msgs[0]?.content ?? "").includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const toolsSince = msgs.slice(lastUserIdx).filter((m) => m.role === "tool");
  const last = String(msgs[lastUserIdx]?.content ?? "");
  modes.push(tools.includes("write_file") ? "agent" : tools.includes("web_search") ? "chat+web" : "plain");
  // First answer from memory, like a model that does not think to look it up.
  if (!/current information from the web/.test(last)) return { text: "Node.js 20 is the LTS release." };
  if (toolsSince.length === 0) return { text: "Let me check.", call: { name: "web_search", args: { query: "Node.js LTS release" } } };
  if (toolsSince.length === 1) return { text: "", call: { name: "fetch_url", args: { url: RESULTS[0].url } } };
  return { text: "The current Node.js LTS line is listed on the Node.js releases page (nodejs.org), with background on Wikipedia." };
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
  await new Promise((r) => search.listen(SEARCH_PORT, "127.0.0.1", r));
  const env = {
    ...process.env,
    ORVYN_DATA_DIR: dataDir, PORT: String(PORT),
    ORVYN_WEB_SEARCH_URL: `http://127.0.0.1:${SEARCH_PORT}/html/`,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.BRAVE_SEARCH_API_KEY;
  for (const k of ["CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "FIREWORKS_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const log = [];
  const server = startBackend(env, log);
  let app, win;
  try {
    ok(await healthy(), "ORVYN's engine started");
    mkdirSync(userData, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(userData, "orvyn-connection.json"), JSON.stringify({ backendUrl: `http://localhost:${PORT}`, apiKey: "" }));
    writeFileSync(join(userData, "orvyn-recents.json"), JSON.stringify([project]));
    ({ app, win } = await launchApp());

    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(Q);
    await win.getByRole("button", { name: /Run mission/ }).click();
    // Chat never asks before searching; an approval card here would be a failure.
    const askedApproval = await waitFor(async () => (await win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).count()) > 0 || /listed on the Node\.js releases page/.test(await win.locator("body").innerText()) ? (await win.getByRole("button", { name: /Allow for Mission|Allow Once/ }).count()) > 0 : null, 30_000, 300);
    ok(!!(await waitFor(async () => /listed on the Node\.js releases page/.test(await win.locator("body").innerText()), 30_000, 300)), "the question was answered in chat");
    ok(((await api("/agent/stream/runs")).json.runs ?? []).length === 0, "…as a chat reply (no task was started)");
    ok(modes.includes("chat+web"), "the chat model was offered web search", JSON.stringify(modes));
    ok(searches.length >= 1, `ORION searched the web on its own (${searches.join(", ")})`);
    ok(!askedApproval, "…without asking for approval");
    const answer = await win.locator("body").innerText();
    ok(!/Node\.js 20 is the LTS release/.test(answer), "the unchecked answer from memory is not left in the chat");
    const summary = win.locator('[data-testid="research-summary"]');
    ok((await summary.count()) === 1 && /Searched the web/.test(await summary.innerText()), "the reply shows what ORION researched", await summary.innerText().catch(() => ""));
    if (!(await win.locator('[data-testid="research-step"]').count())) await summary.click();
    const steps = await win.locator('[data-testid="research-step"]').allInnerTexts();
    ok(steps.length === 2 && /Node\.js LTS release/.test(steps[0]) && /2 results/.test(steps[0]) && /nodejs\.org/.test(steps[1]), "…each search (query · 2 results) and page read (URL · site)", JSON.stringify(steps));
    const sessions = (await api("/sessions")).json.sessions ?? [];
    const stored = (await api(`/sessions/${sessions[0]?.sessionId}/messages`)).json.messages ?? [];
    const reply = stored.find((m) => m.role === "assistant");
    ok(reply?.meta?.activity?.length === 2 && /listed on the Node\.js releases page/.test(reply.content) && !/Node\.js 20/.test(reply.content), "the research and the researched answer are stored with the conversation", JSON.stringify(reply ?? null).slice(0, 300));
    const chip = win.locator('[data-testid="sources-chip"]');
    ok(!!(await waitFor(async () => (await chip.count()) === 1, 15_000, 300)), "a Sources chip is under ORION's answer");
    ok(/Sources\s*2/.test(await chip.innerText()), "…counting 2 sources", await chip.innerText());
    ok((await chip.locator("img, .sources__letter").count()) === 2, "…with one icon per site");
    await chip.click();
    const rows = win.locator('[data-testid="source-row"]');
    const texts = await rows.allInnerTexts();
    ok(texts.length === 2 && /Node\.js Releases/.test(texts[0]) && /nodejs\.org/.test(texts[0]) && /wikipedia\.org/.test(texts[1]), "clicking it lists each site: title, domain and snippet", JSON.stringify(texts));
    ok(/Found in search · “Node\.js LTS release”/i.test(await win.locator('[data-testid="sources-panel"]').innerText()), "…under the query ORION searched for");
    await win.screenshot({ path: join(OUT, "sources.png") }).catch(() => {});
    await rows.first().click();
    const opened = await waitFor(async () => app.evaluate(() => globalThis.__orvynBrowser?.workbench.snapshot?.().tabs?.map((t) => t.url) ?? globalThis.__orvynBrowser?.workbench.surfaceReport().views.map((v) => v.url)), 15_000, 300);
    const openedUrls = (await app.evaluate(() => { const w = globalThis.__orvynBrowser.workbench; return (w.snapshot?.().tabs ?? []).map((t) => `${t.url}|${t.requestedUrl ?? ""}`); }).catch(() => [])) ?? [];
    ok(JSON.stringify(openedUrls).includes("nodejs.org/en/about/previous-releases"), "clicking a source opens it in the Workbench Browser", JSON.stringify({ opened, openedUrls }));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("sources-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close(); search.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nSOURCES: PASS" : `\nSOURCES: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
