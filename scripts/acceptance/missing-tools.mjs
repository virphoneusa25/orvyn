// scripts/acceptance/missing-tools.mjs
//
// ORION never says "that tool isn't available" — it asks the user to install
// an MCP tool (the install card) so it can finish. End to end through the
// real engine, agent runs and chat, with a scripted model and a blocked
// web search:
//
//   1. Agent: a `multi_tool_use.parallel` wrapper is unwrapped into real
//      web_search calls; the search is blocked, so ORVYN shows ONE install
//      card ("search the web") and tells the model to ask for it.
//   2. Agent: a reply "web search isn't available in this session" is sent
//      back; the model calls search_capabilities and the card is shown.
//   3. Agent: a tool the model invented (send_email) → install card for email.
//   4. Chat: a blocked search shows the install card in the chat reply.
//   5. Chat: "I can't browse the internet" is replaced by asking for the tool.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/missing-tools.mjs

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4781, MODEL_PORT = 4782;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const project = mkdtempSync(join(tmpdir(), "orvyn-cap-project-"));
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-cap-data-"));
writeFileSync(join(project, "README.md"), "# Radio site\n");
spawnSync("git", ["init", "-q"], { cwd: project });

const CLAIM = "I tried to search live websites, but web search isn't available in this session. Examples from memory: KEXP, NTS, NPR.";
const ASK = "To look at live examples I need a web search tool. Install it from the card above and I'll finish.";
const bodies = []; // every model request (for checks)

function lastUser(msgs) {
  return String([...msgs].reverse().find((m) => m.role === "user")?.content ?? "");
}
function firstUser(msgs) {
  // Every user turn (the task plus any nudges), so the script recognises its task.
  return msgs.filter((m) => m.role === "user").map((m) => String(m.content)).join("\n");
}

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  bodies.push(body);
  if (system.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Checked." };
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const tool = msgs.filter((m) => m.role === "tool");
  const since = (() => { const i = msgs.map((m) => m.role).lastIndexOf("user"); return msgs.slice(i).filter((m) => m.role === "tool"); })();
  const user = firstUser(msgs);
  const last = lastUser(msgs);
  const askedForTool = tool.some((t) => /install card|card to add|card to connect|approve installing/.test(String(t.content)));

  if (/examples of radio station websites/.test(user)) {
    if (!tool.length) return { text: "Searching several sites at once.", call: { name: "multi_tool_use.parallel", args: { tool_uses: [
      { recipient_name: "functions.web_search", parameters: { query: "best radio station websites" } },
      { recipient_name: "functions.web_search", parameters: { query: "KEXP website design" } },
    ] } } };
    return { text: askedForTool ? ASK : CLAIM };
  }
  if (/competitor radio pricing/.test(user)) {
    if (/search_capabilities/.test(last) && tools.includes("search_capabilities") && !since.length) return { text: "Finding a search tool.", call: { name: "search_capabilities", args: { query: "search the web" } } };
    return { text: askedForTool ? ASK : CLAIM };
  }
  if (/Email the schedule/.test(user)) {
    if (!tool.length) return { text: "Sending it.", call: { name: "send_email", args: { to: "team@example.com", subject: "Schedule" } } };
    return { text: askedForTool ? "I need an email tool to send it. Install it from the card and I'll send the schedule." : "Email isn't available here." };
  }
  if (/search other websites for examples/.test(user)) {
    if (!tool.length && tools.includes("web_search")) return { text: "", call: { name: "web_search", args: { query: "radio station website examples" } } };
    return { text: askedForTool ? ASK : CLAIM };
  }
  if (/browse a few station sites/.test(user)) {
    if (/search_capabilities/.test(last) && !since.length) return { text: "", call: { name: "search_capabilities", args: { query: "search the web" } } };
    return { text: askedForTool ? ASK : "I can't browse the internet, but from memory: KEXP and NTS." };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    // The keyless web search is blocked (what happened on the user's machine).
    if (req.url?.startsWith("/search")) { res.writeHead(403, { "Content-Type": "text/html" }); return res.end("<html>blocked</html>"); }
    if (req.url?.includes("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: ["scripted-agent", "gpt-5.6-luna", "claude-sonnet-5"].map((id) => ({ id })) }));
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
    if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text } }] });
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

async function runTask(instruction) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot: project, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
  const runId = started.json.runId;
  for (let i = 0; i < 300; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    if (["completed", "error", "cancelled", "blocked"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [] };
    await sleep(200);
  }
  const r = await api(`/agent/stream/runs/${runId}/events.json`);
  return { runId, status: r.json.status, events: r.json.events ?? [] };
}
const finalText = (ev) => {
  // The reply as the user sees it: deltas after the last retraction.
  let text = "";
  for (const e of ev) {
    if (e.type === "message.retracted") text = "";
    if (e.type === "message.delta") text += String(e.data.content ?? "");
  }
  return text;
};

function chat(userMessage) {
  return new Promise((resolveChat) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
    let text = ""; const activity = new Map(); let retracted = 0;
    const done = () => resolveChat({ text, activity: [...activity.values()], retracted });
    sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history: [], userMessage, context: { useRag: false } }));
    sock.onmessage = (ev) => {
      const c = JSON.parse(ev.data);
      if (c.retract) { text = ""; retracted++; }
      if (c.activity) activity.set(c.activity.id, c.activity);
      if (c.delta) text += c.delta;
      if (c.done) { sock.close(); done(); }
    };
    sock.onerror = done;
    setTimeout(done, 60000);
  });
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
    ORVYN_WEB_SEARCH_URL: `${M}/search`,
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY; delete env.BRAVE_SEARCH_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "CHEAPER_INFERENCE_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. Agent: parallel wrapper unwrapped; blocked search → one install card");
    const a = await runTask("Find examples of radio station websites we can learn from");
    const searches = a.events.filter((e) => e.type === "tool.started" && e.data.tool === "web_search");
    ok(searches.length === 2 && !a.events.some((e) => e.type === "tool.started" && /multi_tool_use/.test(e.data.tool)), "multi_tool_use.parallel ran as two real web_search calls", JSON.stringify(a.events.filter((e) => e.type.startsWith("tool.")).map((e) => [e.type, e.data.tool])));
    const capsA = a.events.filter((e) => e.type === "capability.required");
    ok(capsA.length === 1 && capsA[0].data.query === "search the web", "the blocked search showed ONE install card (search the web)", JSON.stringify(capsA.map((e) => e.data)));
    if (process.env.DUMP) console.log(JSON.stringify(a.events.filter((e) => !/delta|terminal/.test(e.type)).map((e) => [e.type, JSON.stringify(e.data).slice(0, 200)]), null, 1));
    ok(finalText(a.events).endsWith(ASK) && !/No file was saved|isn.t available/.test(finalText(a.events)), "ORION asked the user to install the tool instead of saying search is unavailable", finalText(a.events));

    console.log("\n2. Agent: \"web search isn't available\" is sent back; ORION asks for the tool");
    const b = await runTask("Look up competitor radio pricing examples");
    if (process.env.DUMP) console.log(JSON.stringify(b.events.filter((e) => !/delta|terminal/.test(e.type)).map((e) => [e.type, JSON.stringify(e.data).slice(0, 200)]), null, 1));
    ok(b.events.some((e) => e.type === "agent.continue" && /Finding a tool/.test(e.data.reason ?? "")), "the reply that blamed a missing tool was sent back");
    ok(b.events.some((e) => e.type === "tool.started" && e.data.tool === "search_capabilities"), "search_capabilities is offered to every run, and ORION used it");
    if (process.env.DUMP) console.log(JSON.stringify(b.events.filter((e) => /tool\.(completed|failed)|capability/.test(e.type)).map((e) => e.data), null, 1).slice(0, 3000));
    ok(b.events.some((e) => e.type === "capability.required" && e.data.query === "search the web"), "the install card was shown");
    ok(finalText(b.events).endsWith(ASK) && !/isn't available/.test(finalText(b.events)), "the answer asks for the tool; the claim never reaches the user", finalText(b.events));

    console.log("\n3. Agent: an invented tool → install card for it");
    const c = await runTask("Email the schedule to the team");
    const capC = c.events.find((e) => e.type === "capability.required");
    ok(capC?.data?.query === "send and read email", "send_email (no such tool) → card to add an email tool", JSON.stringify(capC?.data ?? null));
    ok(!c.events.some((e) => e.type === "approval.required"), "the invented tool never asked for approval");
    ok(/card/.test(finalText(c.events)) && !/isn't available/.test(finalText(c.events)), "ORION asked for the email tool", finalText(c.events));

    console.log("\n4. Chat: a blocked search shows the install card in the reply");
    const d = await chat("can you search other websites for examples?");
    const capD = d.activity.filter((x) => x.kind === "capability");
    ok(capD.length === 1 && capD[0].query === "search the web" && capD[0].reason, "the chat reply carries one install card", JSON.stringify(d.activity));
    ok(d.text.trim() === ASK, "the chat asks the user to install it", d.text);

    console.log("\n5. Chat: \"I can't browse the internet\" → ask for the tool");
    const e = await chat("Please browse a few station sites and tell me what they do well.");
    ok(e.retracted >= 1, "the reply that blamed a missing tool was withdrawn");
    ok(e.activity.some((x) => x.kind === "capability"), "the install card was shown");
    ok(e.text.trim() === ASK, "the final chat answer asks for the tool", e.text);
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-2000));
  console.log(failures === 0 ? "\nMISSING TOOLS: PASS" : `\nMISSING TOOLS: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
