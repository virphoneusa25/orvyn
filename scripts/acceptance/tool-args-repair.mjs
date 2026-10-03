// scripts/acceptance/tool-args-repair.mjs
//
// The Sep 28 production failure: after writing index.html, ORION's
// write_file for styles.css arrived without path/content and the run was
// blocked after three identical calls. Root cause: a large write_file (plus a
// reasoning model's thinking) hit the 8k output limit, the adapter could not
// parse the cut-off JSON and silently turned it into {}.
//
//   1. {} for write_file → validation fails, nothing runs, ONE repair request,
//      the corrected call writes styles.css, the run continues and completes.
//   2. A write_file cut off at the output limit (finish_reason "length") →
//      flagged "truncated" (not {}), the repair asks for parts; ORION writes
//      the stylesheet in two parts (append) and the file is exactly right; the
//      preview is the styled site.
//   3. The same bad call twice → blocked on the 2nd (no 3rd model/tool cycle),
//      one replan, ORION writes the file another way, the run completes.
//   4. A model that never fixes it → after the replan the run stops truthfully
//      with a plain-words message (no endless retries).
//   5. A large stylesheet (~48 KB) through the stream: path and content intact.
//
// Usage (after `npm run build -w @orvyn/backend`):  node scripts/acceptance/tool-args-repair.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4811, MODEL_PORT = 4812;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const fixture = join(repoRoot, "scripts", "acceptance", "fixtures", "virphone-site");
const work = mkdtempSync(join(tmpdir(), "orvyn-args-"));
const project = (name, withCss = false) => { const dir = join(work, name); cpSync(fixture, dir, { recursive: true }); if (!withCss) cpSync(join(fixture, "index.html"), join(dir, "index.html")); return dir; };

// A new stylesheet the restyle needs (the fixture's styles.css is removed per scenario).
const CSS1 = ":root{--bg:#070b14;--ink:#e6edf7;--brand:#3b82f6}\nbody{margin:0;background:var(--bg);color:var(--ink);font-family:Inter,system-ui,sans-serif}\n.header{position:sticky;top:0;background:rgba(7,11,20,.9)}\n";
const CSS2 = ".hero{padding:140px 0 90px;text-align:center;background:radial-gradient(ellipse at top,rgba(59,130,246,.25),transparent 60%)}\n.hero h1{font-size:56px;font-weight:800;letter-spacing:-.02em}\n.card{background:#0f1726;border:1px solid rgba(255,255,255,.08);border-radius:16px;padding:24px}\n";
const BIG = Array.from({ length: 1400 }, (_, i) => `.u-${i}{margin:${i % 48}px;color:#${(i * 2654435761 >>> 8).toString(16).padStart(6, "0").slice(0, 6)}}`).join("\n");
const seen = { modelCalls: {}, repairNotes: [] };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");

// Each turn: { text?, call?: {name, args?, raw?}, finish? }
function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const results = msgs.filter((m) => m.role === "tool");
  const users = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const first = users.find((u) => /^Scenario/.test(u)) ?? "";
  const lastTool = textOf(results[results.length - 1]?.content);
  if (system.includes("ORVYN VERIFIER")) return { text: "VERDICT: PASS\n- styles.css is written and linked; the page is styled." };
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  if (!tools.includes("write_file")) return { text: "OK." };
  const key = (first.match(/^Scenario (\d)/) ?? [])[1] ?? "?";
  seen.modelCalls[key] = (seen.modelCalls[key] ?? 0) + 1;
  if (/INVALID_TOOL_ARGUMENTS/.test(lastTool)) seen.repairNotes.push(`${key}:${lastTool}`);
  const n = results.length;
  const write = (args) => ({ call: { name: "write_file", args } });
  if (key === "1") {
    if (n === 0) return { text: "Now the stylesheet.", call: { name: "write_file", raw: "{}" } };
    if (n === 1) return write({ path: "styles.css", content: CSS1 + CSS2 });
    return { text: "The stylesheet is written." };
  }
  if (key === "2") {
    const full = JSON.stringify({ path: "styles.css", content: CSS1 + CSS2 });
    if (n === 0) return { text: "Now the stylesheet.", call: { name: "write_file", raw: full.slice(0, 180) }, finish: "length" };
    if (n === 1) return write({ path: "styles.css", content: CSS1 });
    if (n === 2) return write({ path: "styles.css", content: CSS2, append: true });
    return { text: "The stylesheet is written in two parts." };
  }
  if (key === "3") {
    if (n <= 1) return { call: { name: "write_file", raw: "{}" } };
    // After the replan: a different, valid way.
    if (n === 2) return write({ path: "styles.css", content: CSS1 + CSS2 });
    return { text: "Done after replanning." };
  }
  if (key === "4") {
    if (n < 8) return { call: { name: "write_file", raw: n % 2 ? "{}" : '{"content":"x"}' } };
    return { text: "unreachable" };
  }
  if (key === "5") {
    if (n === 0) return write({ path: "big.css", content: BIG });
    return { text: "Wrote big.css." };
  }
  return { text: "OK." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const args = turn.call ? (turn.call.raw ?? JSON.stringify(turn.call.args)) : "";
    const id = `call_${++seq}`;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text ?? "", tool_calls: turn.call ? [{ id, type: "function", function: { name: turn.call.name, arguments: args } }] : undefined }, finish_reason: turn.finish ?? (turn.call ? "tool_calls" : "stop") }], usage }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (turn.call) {
      send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: "function", function: { name: turn.call.name, arguments: "" } }] } }] });
      for (const piece of args.match(/[\s\S]{1,512}/g) ?? []) send({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] } }] });
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: turn.finish ?? (turn.call ? "tool_calls" : "stop") }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const api = async (path, method = "GET", body) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let json = {}; try { json = JSON.parse(t); } catch { json = { raw: t }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
async function runTask(instruction, projectRoot) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access" });
  const runId = started.json.runId;
  if (!runId) return { status: `start failed ${started.status}`, events: [] };
  for (let i = 0; i < 400; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    if (["completed", "error", "cancelled", "blocked", "failed"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [] };
    await sleep(250);
  }
  return { runId, status: "timeout", events: [] };
}
const of = (run, type) => run.events.filter((e) => e.type === type);
const writesRan = (run) => run.events.filter((e) => e.type === "tool.completed" && e.data?.tool === "write_file").length;

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = { ...process.env, ORVYN_DATA_DIR: join(work, "data"), PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"), MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent" };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "HUGGINGFACE_API_KEY", "HF_TOKEN", "HUGGINGFACE_ROUTING_ENABLED", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\n1. write_file({}) → one repair → the file is written, the run continues");
    const d1 = project("one"); await import("node:fs").then((fs) => fs.rmSync(join(d1, "styles.css"), { force: true }));
    const r1 = await runTask("Scenario 1: restyle the site — write the new stylesheet", d1);
    const vf1 = of(r1, "tool.validation_failed")[0]?.data;
    ok(vf1?.tool === "write_file" && vf1.missing.join(",") === "path,content", "validation failed: write_file missing path, content", JSON.stringify(vf1));
    ok(/"code":"INVALID_TOOL_ARGUMENTS"/.test(seen.repairNotes.find((n) => n.startsWith("1:")) ?? ""), "the model got a structured INVALID_TOOL_ARGUMENTS repair request");
    ok(readFileSync(join(d1, "styles.css"), "utf8") === CSS1 + CSS2, "the corrected call wrote styles.css");
    ok(of(r1, "tool.repaired").length === 1, "tool.repaired recorded");
    ok(r1.status === "completed" && !r1.events.some((e) => e.type === "run.error"), "the mission continued and completed", r1.status);
    ok(seen.modelCalls["1"] <= 4, "no wasted model turns", String(seen.modelCalls["1"]));
    const failedItem = of(r1, "tool.failed").find((e) => e.data?.errorType === "INVALID_ARGUMENTS")?.data;
    ok(failedItem?.recovering === true && /file-edit request was malformed/.test(failedItem.error) && /missing/.test(failedItem.diagnostic), "the user sees plain words (recovering); the schema detail is diagnostics", JSON.stringify(failedItem));

    console.log("\n2. write_file cut off at the output limit → flagged truncated → written in parts");
    const d2 = project("two"); await import("node:fs").then((fs) => fs.rmSync(join(d2, "styles.css"), { force: true }));
    const r2 = await runTask("Scenario 2: restyle the site — write the new stylesheet", d2);
    const vf2 = of(r2, "tool.validation_failed")[0]?.data;
    ok(vf2?.reason === "truncated", "the cut-off call was flagged truncated (never {})", JSON.stringify(vf2));
    ok(/append\\?": true/.test(seen.repairNotes.find((n) => n.startsWith("2:")) ?? ""), "the repair asked for the file in parts (append)");
    ok(readFileSync(join(d2, "styles.css"), "utf8") === CSS1 + CSS2, "styles.css is exactly the full stylesheet (part 1 + appended part 2)");
    const pv = [...r2.events].reverse().find((e) => e.type === "preview.updated" || e.type === "preview.available")?.data?.url;
    const served = pv ? await (await fetch(new URL("styles.css", pv))).text() : "";
    ok(served === CSS1 + CSS2, "the preview serves the whole stylesheet (not just the last part)", `${served.length} vs ${(CSS1 + CSS2).length}`);
    ok(r2.status === "completed", "completed", r2.status);

    console.log("\n3. The same bad call twice → blocked on the 2nd → one replan → done");
    const d3 = project("three"); await import("node:fs").then((fs) => fs.rmSync(join(d3, "styles.css"), { force: true }));
    const r3 = await runTask("Scenario 3: restyle the site — write the new stylesheet", d3);
    const vf3 = of(r3, "tool.validation_failed").map((e) => e.data);
    ok(vf3.length === 2 && vf3[1].blocked === true, "blocked on the 2nd identical call (no 3rd cycle)", JSON.stringify(vf3.map((v) => [v.attempt, v.blocked])));
    ok(r3.events.some((e) => e.type === "agent.continue" && /replanning/.test(String(e.data?.reason))), "one replan of the step");
    ok(existsSync(join(d3, "styles.css")) && readFileSync(join(d3, "styles.css"), "utf8") === CSS1 + CSS2 && r3.status === "completed", "the replanned step wrote the file and the run completed", r3.status);

    console.log("\n4. A model that never fixes it → stops truthfully");
    const r4 = await runTask("Scenario 4: restyle the site — write the new stylesheet", project("four"));
    const err4 = of(r4, "run.error")[0]?.data?.message ?? "";
    ok(["error", "failed"].includes(r4.status) && /malformed/.test(err4) && !/missing: path/.test(err4), "the run failed with plain words", `${r4.status} ${err4}`);
    ok(writesRan(r4) === 0 && seen.modelCalls["4"] <= 5, "no filesystem write ran; no endless retries", `writes=${writesRan(r4)} modelCalls=${seen.modelCalls["4"]}`);

    console.log("\n5. A 60 KB stylesheet through the stream");
    const d5 = project("five");
    const r5 = await runTask("Scenario 5: write a large utility stylesheet", d5);
    ok(existsSync(join(d5, "big.css")) && readFileSync(join(d5, "big.css"), "utf8") === BIG, `big.css (${BIG.length} bytes) arrived intact`);
    ok(of(r5, "tool.validation_failed").length === 0 && r5.status === "completed", "no validation failure, completed", r5.status);
    const meta = of(r5, "tool.validated").find((e) => e.data?.tool === "write_file")?.data;
    ok(meta?.contentBytes === Buffer.byteLength(BIG) && meta.keys.join(",") === "path,content" && !JSON.stringify(meta).includes(".u-10{"), "telemetry records keys and sizes, never the content", JSON.stringify(meta));
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-3000));
  console.log(failures === 0 ? "\nTOOL ARGS REPAIR: PASS" : `\nTOOL ARGS REPAIR: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
