// Real-model Phase 6 acceptance. Uses the configured provider from .env.
// Creates a temporary website fixture, runs the exact two prompts in one chat,
// restarts the backend, then asks the restart follow-up.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4693, BASE = `http://127.0.0.1:${PORT}`;
const repo = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const resume = Boolean(process.env.PHASE6_RESUME_SITE && process.env.PHASE6_RESUME_DATA && process.env.PHASE6_RESUME_SESSION);
const project = resume ? process.env.PHASE6_RESUME_SITE : mkdtempSync(join(tmpdir(), "orvyn-phase6-site-"));
const dataDir = resume ? process.env.PHASE6_RESUME_DATA : mkdtempSync(join(tmpdir(), "orvyn-phase6-data-"));
if (!resume) {
mkdirSync(join(project, "test"));
writeFileSync(join(project, "index.html"), '<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>VirPhone</title><link rel="stylesheet" href="styles.css"></head><body><main><h1>VirPhone</h1><p>Thoughtful technology for a more connected world.</p></main></body></html>');
writeFileSync(join(project, "styles.css"), 'body{margin:0;background:#f0f5f2;color:#123; font-family:Arial,sans-serif} main{min-height:80vh;padding:4rem}');
writeFileSync(join(project, ".gitignore"), ".orvyn/\ndist/\nnode_modules/\n");
writeFileSync(join(project, "package.json"), JSON.stringify({ name: "virphone-acceptance", private: true, type: "module", scripts: { build: "node scripts/build.mjs", test: "node --test" } }, null, 2));
mkdirSync(join(project, "scripts"));
writeFileSync(join(project, "scripts", "build.mjs"), 'import {readFileSync,mkdirSync,copyFileSync} from "node:fs"; const html=readFileSync("index.html","utf8"); if(!html.includes("<main")) throw Error("main missing"); mkdirSync("dist",{recursive:true}); copyFileSync("index.html","dist/index.html"); copyFileSync("styles.css","dist/styles.css");');
writeFileSync(join(project, "test", "site.test.mjs"), 'import {test} from "node:test"; import {readFileSync} from "node:fs"; test("homepage exists",()=>{if(!readFileSync("index.html","utf8").includes("VirPhone")) throw Error("missing site")});');
execFileSync("git", ["init", "-q"], { cwd: project });
execFileSync("git", ["add", "."], { cwd: project });
execFileSync("git", ["-c", "user.name=Acceptance", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", "Website fixture"], { cwd: project });
}

let backend;
async function startBackend() {
  backend = spawn(process.execPath, ["dist/index.js"], { cwd: join(repo, "apps", "backend"), env: { ...process.env, PORT: String(PORT), ORVYN_DATA_DIR: dataDir }, stdio: "ignore" });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) return; } catch {} await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("backend did not start");
}
async function run(instruction, sessionId) {
  const start = await fetch(`${BASE}/api/v1/agent/stream/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectRoot: project, instruction, mode: "agent", composerMode: "code", permissionMode: "full_access", executionTarget: "auto", ...(sessionId ? { sessionId } : {}) }) });
  const info = await start.json();
  if (!info.runId) return { instruction, startError: info, status: "start-failed", events: [] };
  const events = []; let after = 0, status = "running";
  const deadline = Date.now() + 8 * 60_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${BASE}/api/v1/agent/stream/runs/${info.runId}/events.json?after=${after}`);
    const data = await response.json();
    for (const event of data.events ?? []) { events.push(event); after = Math.max(after, Number(event.sequence ?? 0)); }
    status = data.status;
    if (!["running", "queued", "awaiting_approval", "verifying"].includes(status)) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  return { instruction, runId: info.runId, sessionId: info.sessionId, status, events };
}
function report(result) {
  const tools = result.events.filter((e) => e.type === "tool.completed" || e.type === "tool.failed").map((e) => `${e.data?.tool}:${e.type === "tool.completed" ? "ok" : "failed"}`);
  const lastToolSequence = Math.max(0, ...result.events.filter((e) => (e.type === "tool.completed" || e.type === "tool.failed") && !e.data?.verifier).map((e) => Number(e.sequence ?? 0)));
  const grounded = result.events.findLast((e) => e.type === "message.grounded")?.data?.content;
  const final = String(grounded ?? result.events.filter((e) => e.type === "message.delta" && Number(e.sequence ?? 0) > lastToolSequence).map((e) => e.data?.content ?? "").join("")).trim();
  const verification = result.events.filter((e) => e.type === "verification.completed").pop()?.data;
  console.log(JSON.stringify({ instruction: result.instruction, runId: result.runId, status: result.status, tools, verification: verification?.verdict, findings: verification?.findings, final, error: result.events.findLast((e) => e.type === "run.error")?.data?.message, startError: result.startError }, null, 2));
}
let failed = false;
try {
  await startBackend();
  const first = resume
    ? { status: "completed", sessionId: process.env.PHASE6_RESUME_SESSION, instruction: "can you add a hero image in the background", events: [] }
    : await run("can you add a hero image in the background");
  if (!resume) report(first);
  if (first.status !== "completed") throw new Error(`First acceptance mission ended ${first.status}; follow-ups cannot be certified.`);
  const second = process.env.PHASE6_RESUME_STAGE === "third"
    ? { status: "completed", sessionId: first.sessionId, instruction: "can you add the hero and make it animated", events: [] }
    : await run("can you add the hero and make it animated", first.sessionId);
  if (process.env.PHASE6_RESUME_STAGE !== "third") report(second);
  if (second.status !== "completed") throw new Error(`Second acceptance mission ended ${second.status}; restart follow-up cannot be certified.`);
  backend.kill(); await new Promise((r) => backend.once("exit", r));
  await startBackend();
  const third = await run("make the hero animation slower", first.sessionId); report(third);
  const files = ["index.html", "styles.css"].filter((file) => existsSync(join(project, file)));
  const asset = existsSync(join(project, "public")) ? (await import("node:fs")).readdirSync(join(project, "public")) : [];
  const status = execFileSync("git", ["status", "--short"], { cwd: project, encoding: "utf-8" });
  console.log(JSON.stringify({ project, files, assets: asset, gitStatus: status.trim() }, null, 2));
  failed = [first, second, third].some((r) => r.status !== "completed");
} catch (error) { failed = true; console.error(error); }
finally { backend?.kill(); }
console.log(failed ? "PHASE 6: FAIL" : "PHASE 6: PASS");
process.exit(failed ? 1 : 0);
