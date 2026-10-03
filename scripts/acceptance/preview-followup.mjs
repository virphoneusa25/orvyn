// scripts/acceptance/preview-followup.mjs
//
// A website built in one run, then a follow-up in the same chat, the way a
// user works (screenshots from Sep 28):
//   1. "Build a simple VirPhone website": index.html links styles.css; both are written.
//   2. "Yes, and show it in preview" (same chat): the preview opens with the
//      site at the start of the run, STYLED (styles.css is served), even
//      though this run never touched styles.css.
//   3. The model tries to start its own Node server for the static site: refused.
//   4. search_code on one file (path: "styles.css") works (was spawn ENOTDIR).
//   5. "Where is the CSS?" in the same chat is answered by ORION with its tools.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/preview-followup.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4771, MODEL_PORT = 4772;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-pf-data-"));

const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>VirPhone</title><link rel="stylesheet" href="styles.css"></head><body><header class="container"><h1>VirPhone</h1></header><main class="container"><p>Wholesale voice termination.</p></main><script src="script.js"></script></body></html>';
const CSS = ".container{max-width:960px;margin:0 auto}body{background:#0b1220;color:#fff;font-family:system-ui}";
const JS = "document.documentElement.dataset.ready='1';";

const seen = { tools: new Set(), refused: "", search: "", logoPath: "", offeredGenerate: false, handoffNote: "" };

function toolResultsSinceUser(msgs) {
  const i = msgs.map((m) => m.role).lastIndexOf("user");
  return msgs.slice(i).filter((m) => m.role === "tool");
}

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");
  const user = textOf([...msgs].reverse().find((m) => m.role === "user" && !/^(Budget note|\[)/.test(textOf(m.content)))?.content);
  if (system.includes("ORVYN VERIFIER")) {
    // The independent verifier opens the published page before it passes it.
    const url = (system.match(/Published page: (\S+)/) ?? [])[1];
    const results = msgs.filter((m) => m.role === "tool");
    if (url && results.length === 0) return { text: "", call: { name: "browser_open", args: { url } } };
    if (url && results.length === 1) return { text: "", call: { name: "browser_console_errors", args: {} } };
    return { text: "VERDICT: PASS\n- The page loads its stylesheet and script." };
  }
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  for (const t of tools) seen.tools.add(t);
  const since = toolResultsSinceUser(msgs);
  const shell = tools.includes("terminal") ? "terminal" : tools.includes("run_command") ? "run_command" : null;
  if (!tools.length) return { text: "OK." };
  // The chat (web tools only) asked to edit the site: it looks for a tool.
  if (/Chat: edit the header/.test(user) && !tools.includes("write_file")) {
    const got = msgs.filter((m) => m.role === "tool");
    if (!got.length && tools.includes("search_capabilities")) return { text: "", call: { name: "search_capabilities", args: { query: "edit the VirPhone website header" } } };
    seen.handoffNote = String(got[0]?.content ?? "");
    return { text: "I'm doing it now." };
  }
  if (/Build a simple VirPhone website/.test(user)) {
    // Gate nudges arrive as new user turns: count this run's tool results, not only the last turn's.
    const since = msgs.filter((m) => m.role === "tool");
    if (since.length === 0) return { text: "Writing the page.", call: { name: "write_file", args: { path: "index.html", content: HTML } } };
    if (since.length === 1) return { text: "Styles.", call: { name: "write_file", args: { path: "styles.css", content: CSS } } };
    if (since.length === 2) return { text: "Script.", call: { name: "write_file", args: { path: "script.js", content: JS } } };
    const url = (JSON.stringify(msgs).match(/https?:\/\/[^\s"\\]+\/api\/v1\/sites\/[\w-]+\//) ?? [])[0];
    const opened = since.some((t) => /browser/i.test(String(t.name ?? "")) || /Opened|Title|loaded/i.test(String(t.content ?? "")));
    if (process.env.PF_DEBUG) console.error("BUILD", since.length, url, opened, tools.filter((t) => /browser/.test(t)).join(","));
    if (url && !opened && tools.includes("browser_open") && since.length < 6) return { text: "Checking it.", call: { name: "browser_open", args: { url } } };
    return { text: "Built the VirPhone site: index.html, styles.css and script.js." };
  }
  if (/show it in preview/i.test(user)) {
    if (since.length === 0) return { text: "Reading the page.", call: { name: "read_file", args: { path: "index.html" } } };
    if (since.length === 1 && shell) return { text: "Starting a server.", call: { name: shell, args: { command: 'cd "$(pwd)" && nohup node .orvyn/serve.js > /tmp/virphone.log 2>&1 &' } } };
    if (since.length <= 2) {
      if (shell) seen.refused = String(since[1]?.content ?? "");
      return { text: "Checking the container rule.", call: { name: "search_code", args: { pattern: "containe", path: "styles.css" } } };
    }
    seen.search = String(since[since.length - 1]?.content ?? "");
    return { text: "The site is in the Preview tab." };
  }
  if (/use this logo/i.test(user)) {
    const note = JSON.stringify(msgs).match(/saved in the project as ([^\s)\\]+)\)/);
    if (process.env.PF_DEBUG) console.error("LOGO", since.length, JSON.stringify(msgs).match(/.{80}attached.{160}/)?.[0]);
    seen.logoPath = note ? note[1] : "";
    if (since.length === 0 && seen.logoPath) return { text: "Adding your logo.", call: { name: "edit_file", args: { path: "index.html", old_text: "<h1>VirPhone</h1>", new_text: `<h1><img src="${seen.logoPath}" alt="VirPhone"></h1>` } } };
    if (tools.includes("generate_image")) seen.offeredGenerate = true;
    return { text: "Your logo is on the page." };
  }
  if (/Where is the CSS/i.test(user)) {
    if (since.length === 0) return { text: "Looking.", call: { name: "read_file", args: { path: "styles.css" } } };
    return { text: `styles.css is in the project (${String(since[0]?.content ?? "").length} characters) and the page links it.` };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] }));
    }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const toolCalls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (toolCalls) send({ choices: [{ index: 0, delta: { tool_calls: toolCalls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function runTask(instruction, extra = {}) {
  const started = await api("/agent/stream/runs", "POST", { instruction, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access", ...extra });
  const runId = started.json.runId;
  if (!runId) return { runId, status: `start failed ${started.status}: ${JSON.stringify(started.json).slice(0, 300)}`, events: [], sessionId: null };
  let status = "";
  for (let i = 0; i < 400; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    status = r.json.status;
    if (["completed", "error", "cancelled", "blocked"].includes(status)) return { runId, status, events: r.json.events ?? [], sessionId: started.json.sessionId };
    await sleep(250);
  }
  return { runId, status, events: [], sessionId: started.json.sessionId };
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Build the site");
    const build = await runTask("Build a simple VirPhone website, it's a wholesale VoIP carrier");
    ok(build.status === "completed", "the build run finished", `${build.status} ${JSON.stringify(build.events.filter((e) => /error|failed|gate/.test(e.type)).map((e) => [e.type, e.data?.message ?? e.data?.error ?? e.data?.reason]).slice(-5))}`);
    const sessionId = build.sessionId;

    console.log("\n2. Follow-up in the same chat: the preview opens with the styled site");
    const follow = await runTask("Yes, and show it in preview", { sessionId, previousRunId: build.runId });
    ok(follow.status === "completed", "the follow-up ran (no workspace mismatch)", follow.status);
    const types = follow.events.map((e) => e.type);
    const firstPreview = types.indexOf("preview.available");
    const firstTool = types.indexOf("tool.started");
    ok(firstPreview >= 0 && (firstTool < 0 || firstPreview < firstTool), "the preview opened at the start of the run, before any tool", `preview@${firstPreview} tool@${firstTool}`);
    const urls = follow.events.filter((e) => e.type === "preview.available" || e.type === "preview.updated").map((e) => String(e.data?.url ?? "")).filter(Boolean);
    const url = urls[urls.length - 1] ?? "";
    let css = "", page = "";
    if (url) {
      page = await (await fetch(url)).text();
      const r = await fetch(new URL("styles.css", url));
      css = r.ok ? await r.text() : "";
    }
    ok(/rel="stylesheet" href="styles\.css"|<style>[\s\S]*\.container/.test(page) && css.includes(".container"), "the preview serves the page AND its stylesheet", `${url} css=${css.slice(0, 60)}`);

    console.log("\n3. A hand-written Node server for the static site is refused");
    ok(/Preview tab/.test(seen.refused), "`nohup node .orvyn/serve.js &` was refused with the Preview tab explanation", seen.refused.slice(0, 200));

    console.log("\n4. search_code on one file");
    ok(/styles\.css:1:\.container/.test(seen.search) && !/ENOTDIR/.test(seen.search), "search_code {path: \"styles.css\"} found the rule", seen.search.slice(0, 200));

    console.log("\n4b. One preview address per chat; never shown before its stylesheet");
    const buildFirst = build.events.find((e) => e.type === "preview.available");
    ok(Boolean(buildFirst) && String(buildFirst.data?.url) === url, "the follow-up shows the site at the same preview address as the build", `${buildFirst?.data?.url} vs ${url}`);
    const firstSeq = build.events.findIndex((e) => e.type === "preview.available");
    const cssWrite = build.events.findIndex((e) => e.type === "file.edit" && /styles\.css$/.test(String(e.data?.path ?? "")));
    ok(cssWrite >= 0 && firstSeq > cssWrite, "the build's preview appeared only once styles.css existed (never bare HTML)", `preview@${firstSeq} css@${cssWrite}`);

    console.log("\n4c. 'Can you use this logo?' with the logo attached");
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff3f0005fe02fea7d6a4f70000000049454e44ae426082", "hex");
    const logo = await runTask("Can you use this logo for virphone?", { sessionId, previousRunId: follow.runId, attachments: [{ kind: "image", name: "VirPhone_New_Logo.png", mediaType: "image/png", b64: png.toString("base64") }] });
    ok(logo.status === "completed", "the logo run finished", `${logo.status} ${JSON.stringify(logo.events.filter((e) => /error|failed/.test(e.type)).map((e) => [e.type, e.data?.tool, e.data?.error ?? e.data?.message]).slice(-4))}`);
    ok(seen.logoPath === "assets/VirPhone_New_Logo.png", "the attached logo was saved into the project and ORION was told its path", seen.logoPath);
    const logoUrls = logo.events.filter((e) => e.type === "preview.available" || e.type === "preview.updated").map((e) => String(e.data?.url ?? "")).filter(Boolean);
    const logoUrl = logoUrls[logoUrls.length - 1] ?? "";
    const served = logoUrl ? await fetch(new URL("assets/VirPhone_New_Logo.png", logoUrl)) : null;
    const bytes = served?.ok ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
    ok(bytes.equals(png), "the preview serves the user's own logo, byte for byte", `${served?.status} ${bytes.length}`);
    ok(logoUrl === url, "still the same preview address", `${logoUrl} vs ${url}`);

    console.log("\n4d. The chat asked for a tool to edit the website: handed to a task, no marketplace card");
    const acts = await new Promise((resolveChat) => {
      const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
      const found = [];
      sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history: [], userMessage: "Chat: edit the header of my site?", context: { useRag: false } }));
      sock.onmessage = (ev) => { const c = JSON.parse(ev.data); if (c.activity) found.push(c.activity.kind); if (c.done) { sock.close(); resolveChat(found); } };
      sock.onerror = () => resolveChat(found);
      setTimeout(() => resolveChat(found), 15000);
    });
    ok(acts.includes("handoff") && !acts.includes("capability"), "the chat handed the work to a task run (no 'Find a tool' card)", JSON.stringify(acts));
    ok(/starting this as a task/i.test(seen.handoffNote), "ORION was told the task is starting", seen.handoffNote.slice(0, 160));

    console.log("\n5. A question about the project in the same chat");
    const ask = await runTask("Where is the CSS to the preview?", { sessionId, previousRunId: follow.runId });
    const answer = [...ask.events].reverse().find((e) => e.type === "run.completed" || e.type === "message.final")?.data;
    ok(ask.status === "completed" && ask.events.some((e) => e.type === "tool.completed" && e.data?.tool === "read_file"), "ORION looked at styles.css with its tools", `${ask.status} ${JSON.stringify(answer ?? {}).slice(0, 200)}`);
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nPREVIEW FOLLOW-UP: PASS" : `\nPREVIEW FOLLOW-UP: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
