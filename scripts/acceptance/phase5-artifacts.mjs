// Backend integration acceptance for the exact Phase 5 SVG mission.
// Uses a scripted model so tool routing, storage, API bytes and restart can be checked without provider credentials.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4691, MODEL_PORT = 4692, BASE = `http://127.0.0.1:${PORT}`;
const repo = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const project = mkdtempSync(join(tmpdir(), "orvyn-phase5-site-"));
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-phase5-data-"));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 400"><rect width="800" height="400" fill="#0b3954"/><circle cx="590" cy="170" r="110" fill="#77d9bd"/></svg>';
const HTML = '<!doctype html><html><head><title>VirPhone</title><link rel="icon" href="data:,"><style>.hero{min-height:80vh;background:linear-gradient(#0005,#0005),url("public/virphone-hero.svg") center/cover;color:white;padding:3rem}</style></head><body><main class="hero"><h1>VirPhone</h1><p>Discover a clearer way to connect with the people and places that matter most.</p></main></body></html>';
writeFileSync(join(project, "index.html"), '<!doctype html><html><head><title>VirPhone</title></head><body><h1>VirPhone</h1></body></html>');
execFileSync("git", ["init", "-q"], { cwd: project });

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => raw += d);
  req.on("end", () => {
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const messages = body.messages ?? [];
    const available = new Set((body.tools ?? []).map((t) => t.function?.name ?? t.name));
    let answer = "Done. I created virphone-hero.svg in the project and added it as the homepage hero background.";
    let call;
    if (String(messages[0]?.content ?? "").includes("ORVYN VERIFIER")) answer = "VERDICT: PASS\n- Checked the file and browser evidence.";
    else if (available.size) {
      const asked = messages.filter((m) => m.role === "assistant").flatMap((m) => m.tool_calls ?? []);
      const called = (name, file) => messages.some((m) => m.role === "tool" && asked.some((c) => c.id === m.tool_call_id && c.function?.name === name && (!file || JSON.parse(c.function.arguments).path === file)));
      if (!called("write_file", "public/virphone-hero.svg")) { answer = "I'll create the hero SVG and verify it."; call = { name: "write_file", args: { path: "public/virphone-hero.svg", content: SVG } }; }
      else if (!called("write_file", "index.html")) { answer = "The SVG exists. I'll connect it to the homepage."; call = { name: "write_file", args: { path: "index.html", content: HTML } }; }
      else if (!called("browser_open") && available.has("browser_open")) {
        const roots = JSON.parse(readFileSync(join(dataDir, "previews", "roots.json"), "utf-8"));
        answer = "I'll check the rendered homepage in the browser.";
        call = { name: "browser_open", args: { url: `${BASE}/api/v1/sites/${Object.keys(roots)[0]}/` } };
      }
      else if (!called("browser_screenshot") && available.has("browser_screenshot")) { answer = "I'll inspect a screenshot."; call = { name: "browser_screenshot", args: {} }; }
      else if (!called("browser_console_errors") && available.has("browser_console_errors")) { answer = "I'll check the browser console."; call = { name: "browser_console_errors", args: {} }; }
    }
    const calls = call ? [{ index: 0, id: `p5_${++seq}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] : undefined;
    res.writeHead(200, { "Content-Type": body.stream ? "text/event-stream" : "application/json" });
    if (!body.stream) return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: answer, tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }] }));
    const send = (v) => res.write(`data: ${JSON.stringify(v)}\n\n`);
    send({ choices: [{ index: 0, delta: { content: answer } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] });
    res.end("data: [DONE]\n\n");
  });
});

const env = { ...process.env, PORT: String(PORT), ORVYN_DATA_DIR: dataDir, MODEL_API_KEY: "scripted", OPENAI_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent" };
for (const key of ["ORVYN_API_KEY", "OPENAI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "FIREWORKS_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "ASTRA_MODEL_ID", "ORCHESTRATOR_MODEL"]) env[key] = "";
let backend;
async function startBackend() {
  backend = spawn(process.execPath, ["dist/index.js"], { cwd: join(repo, "apps", "backend"), env, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("backend did not start");
}
async function json(path, init) { const r = await fetch(`${BASE}/api/v1${path}`, init); return { status: r.status, body: await r.json() }; }
let failed = 0;
function check(value, message) { console.log(`${value ? "PASS" : "FAIL"} ${message}`); if (!value) failed++; }

try {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  await startBackend();
  const started = await json("/agent/stream/runs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot: project, instruction: "Create virphone-hero.svg and add it as the homepage hero background.", mode: "agent", permissionMode: "full_access", executionTarget: "auto" }) });
  if (!started.body.runId) throw new Error(`run start failed: ${JSON.stringify(started)}`);
  let after = 0, status = "running"; const events = [];
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const poll = await json(`/agent/stream/runs/${started.body.runId}/events.json?after=${after}`);
    for (const event of poll.body.events ?? []) { events.push(event); after = Math.max(after, Number(event.sequence ?? 0)); }
    status = poll.body.status;
    if (!["running", "queued", "awaiting_approval", "verifying"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const asset = join(project, "public", "virphone-hero.svg");
  check(existsSync(asset) && readFileSync(asset, "utf-8") === SVG, "real project SVG exists with the expected bytes");
  check(readFileSync(join(project, "index.html"), "utf-8").includes("public/virphone-hero.svg"), "homepage references the project SVG");
  check(events.some((e) => e.type === "file.evidence" && e.data?.path === "public/virphone-hero.svg" && e.data?.size > 0), "run persisted project file evidence");
  const artifact = events.find((e) => e.type === "artifact.created" && e.data?.name === "virphone-hero.svg")?.data;
  check(Boolean(artifact?.artifactId), "Generated card references a persisted artifact");
  if (artifact?.artifactId) {
    const files = await json("/files");
    check(files.body.locations?.find((x) => x.id === "generated")?.files?.some((f) => f.artifactId === artifact.artifactId), "Files Generated lists the artifact");
    const preview = await fetch(`${BASE}/api/v1/artifacts/${artifact.artifactId}/preview`);
    check(preview.ok && (await preview.text()) === SVG, "thumbnail and Preview endpoint returns SVG bytes");
    const download = await fetch(`${BASE}/api/v1/artifacts/${artifact.artifactId}/download`);
    check(download.ok && download.headers.get("content-disposition")?.includes("virphone-hero.svg") && (await download.text()) === SVG, "Download preserves name and bytes");
    backend.kill(); await new Promise((r) => backend.once("exit", r));
    await startBackend();
    const restored = await fetch(`${BASE}/api/v1/artifacts/${artifact.artifactId}/download`);
    check(restored.ok && (await restored.text()) === SVG, "artifact remains available after backend restart");
  }
  check(status === "completed", `exact acceptance mission completes (status: ${status})`);
  if (status !== "completed") console.log("RUN ERRORS", JSON.stringify(events.filter((e) => /failed|error|blocked|verification/.test(e.type)).slice(-12).map((e) => ({ type: e.type, data: e.data }))));
  if (status !== "completed") console.log("BROWSER TOOLS", JSON.stringify(events.filter((e) => e.type === "tool.completed" && /browser_/.test(e.data?.tool ?? "")).map((e) => ({ tool: e.data?.tool, preview: e.data?.preview }))));
  const final = events.filter((e) => e.type === "message.completed" || e.type === "message.grounded").map((e) => e.data?.content).filter(Boolean).pop();
  console.log(`FINAL ${JSON.stringify(final ?? "")}`);
} catch (error) { failed++; console.error(error); }
finally { backend?.kill(); model.close(); }
console.log(failed ? `PHASE 5: FAIL (${failed})` : "PHASE 5: PASS");
process.exit(failed ? 1 : 0);
