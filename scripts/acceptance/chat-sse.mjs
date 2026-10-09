// Real HTTP SSE integration; delayed mock provider, no paid inference or native input.
// scripts/acceptance/chat-live.mjs
//
// PHASE 1 follow-up — the chat shows the work WHILE it happens:
//   * ORION's own opening sentence arrives before any tool runs;
//   * no scripted sentences from the app;
//   * a running command's output reaches the app while it runs, and the
//     chat shows the row as running with that output;
//   * status notes and completion checks do not stay in the chat;
//   * exactly one final answer, after the last tool.
//
// A scripted model drives a command that prints 5 lines over ~3 seconds.
// Events are timed as the CLIENT receives them, not by server timestamps.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node --experimental-strip-types --no-warnings scripts/acceptance/chat-live.mjs

import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PORT = 4683, MODEL_PORT = 4684, BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const INTRO = "I'll run the slow counter and report what it prints.";
const SLOW = `node -e "let i=0;const t=setInterval(()=>{console.log('tick '+(++i));if(i===5)clearInterval(t)},600)"`;

function nextTurn(body) {
  // The independent verifier (VerificationRuntime) asks the same model; this stand-in approves and lets the automatic read-only checks decide.
  if (String(body.messages?.[0]?.content ?? "").includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- Reviewed the automatic checks." };
  const msgs = body.messages ?? [];
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (!tools.length) return { text: "OK." };
  const ran = msgs.some((m) => m.role === "tool");
  if (!ran) return { text: INTRO, call: { name: "terminal", args: { command: SLOW } } };
  const out = String(msgs.filter((m) => m.role === "tool").pop()?.content ?? "");
  return { text: `Done. The counter printed ${out.match(/tick \d/g)?.length ?? 0} lines, ending with tick 5.` };
}
let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", async () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const p of turn.text.match(/[\s\S]{1,10}/g) ?? []) { send({ choices: [{ index: 0, delta: { content: p } }] }); await new Promise(r => setTimeout(r, 75)); }
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } });
    res.write("data: [DONE]\n\n"); res.end();
  });
});

let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; };
const neutral = ["NEBIUS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "HF_TOKEN", "HUGGINGFACE_API_KEY", "ORVYN_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID", "ORCHESTRATOR_MODEL", "OPENAI_CODE_MODEL"].reduce((a, k) => ({ ...a, [k]: "" }), {});
const { reducePresentation } = await import(pathToFileURL(join(repoRoot, "apps", "desktop", "src", "renderer", "presentationReducer.ts")).href);

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const projectDir = mkdtempSync(join(tmpdir(), "orvyn-live-project-"));
  execSync("git init -q", { cwd: projectDir });
  const server = spawn(process.execPath, ["dist/index.js"], {
    cwd: join(repoRoot, "apps", "backend"),
    env: { ...process.env, ...neutral, MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", ORVYN_DATA_DIR: mkdtempSync(join(tmpdir(), "orvyn-live-data-")), PORT: String(PORT), ORVYN_CLOUD_MODE: "false", ORVYN_PROJECTS_DIR: "" },
    stdio: ["ignore","pipe","pipe"],
  });
  let backendLog="";
  server.stdout.on("data", chunk=>{backendLog=(backendLog+chunk.toString()).slice(-8000)});
  server.stderr.on("data", chunk=>{backendLog=(backendLog+chunk.toString()).slice(-8000)});
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 250)); }
    const started = await (await fetch(`${BASE}/api/v1/agent/stream/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot: projectDir, remoteProjectRoot: projectDir, executionTarget: "auto", composerMode: "code", instruction: "Run the slow counter and tell me what it prints.", mode: "agent", permissionMode: "full_access" }) })).json();
    const runId = started.runId;
    const events = [];
    const seen = {}; // event type -> client time first seen
    let snapshotAtFirstOutput = null;
    let after = 0, status = "running";
    const t0 = Date.now();
    const { readSseStream } = await import(pathToFileURL(join(repoRoot, "apps/web/src/lib/sse.ts")).href);
    const response = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events`, { signal: AbortSignal.timeout(60_000) });
    ok(response.ok && response.headers.get("content-type")?.includes("text/event-stream"), "real SSE response");
    let partialText = "", firstPartialAt = 0, fullIntroAt = 0;
    await readSseStream(response.body, e => {
      if (!e.type || !Number.isFinite(e.sequence) || e.sequence <= after) return;
      events.push(e); after = e.sequence; seen[e.type] ??= Date.now();
      if (e.type === "message.delta") {
        partialText += String(e.data?.content ?? "");
        if (!firstPartialAt) firstPartialAt = Date.now();
        if (!fullIntroAt && partialText.includes(INTRO)) fullIntroAt = Date.now();
      }
      if (e.type === "terminal.output" && !snapshotAtFirstOutput) snapshotAtFirstOutput = reducePresentation([...events], "running");
      if (e.type === "run.completed") status = "completed";
      if (/^run\.(error|cancelled|partial)$/.test(e.type)) status = e.type.slice(4);
    });
    ok(fullIntroAt - firstPartialAt >= 150, "partial provider text reaches SSE client before full sentence", `${fullIntroAt-firstPartialAt} ms`);
    const replay = [];
    const resumed = await fetch(`${BASE}/api/v1/agent/stream/runs/${runId}/events?after=${after}`, { signal: AbortSignal.timeout(10_000) });
    await readSseStream(resumed.body, e => { if (Number.isFinite(e.sequence)) replay.push(e); });
    ok(replay.every(e => e.sequence > after), "reconnect cursor does not replay consumed events");
    const text = events.filter((e) => e.type === "message.delta").map((e) => String(e.data?.content ?? "")).join("");
    const outputs = events.filter((e) => e.type === "terminal.output");
    ok(status === "completed", "run completes", `status=${status}; ${JSON.stringify(events.filter(e=>e.type.includes("blocked")||e.type.includes("failed")).map(e=>e.data))}`);
    ok(text.startsWith(INTRO), "ORION's own opening sentence comes first", text.slice(0, 120));
    const firstIdx = (t) => events.findIndex((e) => e.type === t);
    ok(firstIdx("message.delta") >= 0 && firstIdx("message.delta") < firstIdx("tool.started"), "ORION speaks before the tool starts");
    ok(!/active environment|first files in place/i.test(text) && !events.some((e) => e.type === "conversation.message"), "no scripted sentences from the app");
    ok(outputs.length >= 3, "the command's output streamed in pieces", `${outputs.length} output events; ${JSON.stringify(events.filter(e=>e.type==="tool.failed"||e.type==="terminal.completed").map(e=>e.data))}`);
    const lead = (seen["tool.completed"] ?? 0) - (seen["terminal.output"] ?? Infinity);
    ok(lead >= 1500, "output reached the app while the command was still running", `first output ${lead} ms before the command finished`);
    const rows = (snapshotAtFirstOutput ?? []).flatMap((i) => (i.kind === "workgroup" ? i.items : i.kind === "tool" ? [i] : []));
    ok(rows.some((r) => r.status === "running" && /tick 1/.test(r.output ?? "")), "the chat showed a running row with the live output", JSON.stringify(rows.map((r) => [r.status, r.output])));
    const final = reducePresentation(events, status);
    const leftover = final.filter((i) => i.kind === "status" && !/^Execution ·/.test(i.label) && !i.thought);
    ok(leftover.length === 0, "no status or check rows left in the finished chat (only Execution and Thought markers)", JSON.stringify(leftover));
    const lastTool = final.map((i) => ["tool", "workgroup", "group"].includes(i.kind)).lastIndexOf(true);
    const afterTool = final.slice(lastTool + 1).filter((i) => i.kind === "assistant");
    ok(afterTool.length === 1 && /tick 5/.test(afterTool[0].content), "exactly one final answer after the last tool", JSON.stringify(afterTool.map((a) => a.content)));
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.message); console.error(backendLog);
  } finally { server.kill(); model.close(); }
  console.log(failures === 0 ? "\nCHAT SSE: PASS" : `\nCHAT SSE: FAIL (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}
main();

