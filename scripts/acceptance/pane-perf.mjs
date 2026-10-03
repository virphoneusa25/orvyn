// scripts/acceptance/pane-perf.mjs
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

const PORT = 4721, MODEL_PORT = 4722;
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
  if (last.startsWith("Read the 100 notes")) {
    const n = toolsSince.length;
    if (n >= 40) return { text: "LONG-RUN-DONE" };
    return { text: `Reading note ${n + 1}.`, call: { name: "read_file", args: { path: `notes/note-${String(n + 1).padStart(3, "0")}.md` } } };
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

    // A finished task in a project, the right pane open (as after a run).
    await win.getByPlaceholder(/Describe what ORVYN should build/).fill(M1);
    await win.getByRole("button", { name: /Run mission/ }).click();
    await settled(1);
    await sleep(2000);
    const cdp = await win.context().newCDPSession(win);
    await cdp.send("Performance.enable");
    const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const reqs = { n: 0, paths: {} };
    win.on("request", (r) => { const p = new URL(r.url()).pathname.replace(/[0-9a-f-]{20,}/g, ":id"); reqs.n++; reqs.paths[p] = (reqs.paths[p] ?? 0) + 1; });
    await win.evaluate(() => {
      window.__long = 0; window.__longMs = 0; window.__renders = 0;
      new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__long++; window.__longMs += e.duration; } }).observe({ entryTypes: ["longtask"] });
      new MutationObserver((m) => { window.__renders += m.length; }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const measure = async (label) => {
      reqs.n = 0; reqs.paths = {};
      await win.evaluate(() => { window.__long = 0; window.__longMs = 0; window.__renders = 0; });
      const m0 = await metric();
      await sleep(10_000);
      const m1 = await metric();
      const out = await win.evaluate(() => ({ long: window.__long, longMs: Math.round(window.__longMs), mutations: window.__renders }));
      const busy = ((m1.TaskDuration - m0.TaskDuration) / 10) * 100;
      console.log(`  ${label}: main thread busy ${busy.toFixed(1)}% · script ${(m1.ScriptDuration - m0.ScriptDuration).toFixed(2)}s · layouts ${m1.LayoutCount - m0.LayoutCount} · style recalcs ${m1.RecalcStyleCount - m0.RecalcStyleCount} · DOM mutations ${out.mutations} · long tasks ${out.long} (${out.longMs} ms) · requests ${reqs.n} ${JSON.stringify(reqs.paths)}`);
      return { busy, ...out, reqs: reqs.n };
    };
    const results = {};
    results.idle = await measure("idle (run finished, pane open)");
    for (const tab of ["Terminal", "Desktop", "Files", "Browser"]) {
      const t = win.getByRole("tab", { name: new RegExp(`^${tab}`) }).first();
      const b = win.locator(`button:has-text("${tab}")`).first();
      if (await t.isVisible().catch(() => false)) await t.click(); else if (await b.isVisible().catch(() => false)) await b.click(); else { console.log(`  (no ${tab} tab)`); continue; }
      await sleep(1500);
      results[tab] = await measure(`pane: ${tab}`);
    }
    // A long run: 60 tool calls streaming into the chat and the right pane.
    await win.evaluate(() => { window.__frames = []; let last = performance.now(); const loop = (t) => { window.__frames.push(t - last); last = t; if (window.__frames.length < 100000) requestAnimationFrame(loop); }; requestAnimationFrame(loop); });
    const t0 = Date.now();
    const m0 = await metric();
    await win.evaluate(() => { window.__long = 0; window.__longMs = 0; });
    const box = win.locator("textarea").last();
    mkdirSync(join(project, "notes"), { recursive: true });
    for (let i = 1; i <= 100; i++) writeFileSync(join(project, "notes", `note-${String(i).padStart(3, "0")}.md`), `# Note ${i}\n\n${"Some text. ".repeat(40)}\n`);
    await box.click(); await box.fill("Read the 100 notes in the notes folder, one per step (the first 40)"); await box.press("Enter");
    await cdp.send("Profiler.enable"); await cdp.send("Profiler.setSamplingInterval", { interval: 500 }); await cdp.send("Profiler.start");
    setTimeout(async () => {
      const anims = await win.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").map((a) => {
        const el = a.effect?.target; const kf = a.effect?.getKeyframes?.() ?? [];
        return { name: a.animationName ?? a.constructor.name, props: [...new Set(kf.flatMap((k) => Object.keys(k).filter((x) => !["offset", "easing", "composite", "computedOffset"].includes(x))))].join(","), el: el ? `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}` : "", size: el ? Math.round(el.getBoundingClientRect().width) + "x" + Math.round(el.getBoundingClientRect().height) : "" };
      })).catch(() => []);
      console.log("  running animations mid-run:\n" + anims.map((a) => `    ${a.name} [${a.props}] ${a.el} ${a.size}`).join("\n"));
    }, 5000);
    const samples = [];
    let prev = await metric(), prevAt = Date.now();
    const sampler = setInterval(async () => { const m = await metric().catch(() => null); if (!m) return; const now = Date.now(); samples.push(((m.TaskDuration - prev.TaskDuration) / ((now - prevAt) / 1000)) * 100); prev = m; prevAt = now; }, 3000);
    const r2 = await waitFor(async () => { const r = await runs(); return r.length >= 2 && ["completed", "error", "cancelled"].includes(r[1].status) ? r : null; }, 180_000, 500);
    clearInterval(sampler);
    const { profile } = await cdp.send("Profiler.stop");
    {
      const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
      const dt = profile.timeDeltas; const counts = new Map();
      profile.samples.forEach((id, i) => counts.set(id, (counts.get(id) ?? 0) + (dt[i] ?? 0)));
      for (const [id, us] of counts) { const n = byId.get(id); const f = n.callFrame; const key = `${f.functionName || "(anon)"} ${String(f.url).split("/").pop()}:${f.lineNumber}`; self.set(key, (self.get(key) ?? 0) + us); }
      const total = [...self.values()].reduce((a, b) => a + b, 0);
      console.log("  top self time:\n" + [...self.entries()].filter(([k]) => !/^\(idle\)|\(program\)/.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `    ${(v / 1000).toFixed(0).padStart(6)} ms  ${(v / total * 100).toFixed(1).padStart(5)}%  ${k}`).join("\n"));
    }
    console.log(`  load over the run (3 s samples): ${samples.map((x) => x.toFixed(0) + "%").join(" ")}`);
    const secs = (Date.now() - t0) / 1000;
    const m1 = await metric();
    const long = await win.evaluate(() => ({ long: window.__long, longMs: Math.round(window.__longMs), frames: window.__frames.slice() }));
    const sorted = long.frames.slice().sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const busyRun = ((m1.TaskDuration - m0.TaskDuration) / secs) * 100;
    console.log(`  breakdown: script ${(m1.ScriptDuration - m0.ScriptDuration).toFixed(2)}s · style ${(m1.RecalcStyleDuration - m0.RecalcStyleDuration).toFixed(2)}s (${m1.RecalcStyleCount - m0.RecalcStyleCount}) · layout ${(m1.LayoutDuration - m0.LayoutDuration).toFixed(2)}s (${m1.LayoutCount - m0.LayoutCount}) · task ${(m1.TaskDuration - m0.TaskDuration).toFixed(2)}s · nodes ${m1.Nodes}`);
    if (r2?.[1]?.status !== "completed") { const ev = await api(`/agent/stream/runs/${r2?.[1]?.id}/events.json`); console.log("  run end:", JSON.stringify((ev.json.events ?? []).filter((e) => /error|finished|blocked|budget|stall/.test(e.type)).slice(-3).map((e) => [e.type, JSON.stringify(e.data).slice(0, 200)]))); }
    console.log(`  long run (40 reads, ${secs.toFixed(1)}s): main thread busy ${busyRun.toFixed(1)}% · long tasks ${long.long} (${long.longMs} ms) · frame p95 ${p95.toFixed(1)} ms · max ${Math.max(...long.frames).toFixed(0)} ms · status ${r2?.[1]?.status}`);
    ok(busyRun < 40, `a long run keeps the main thread under 40% busy (${busyRun.toFixed(1)}%)`);
    ok(r2?.[1]?.status === "completed", "the long run completed");
    ok(p95 < 50, `the UI stays smooth during a long run (frame p95 ${p95.toFixed(1)} ms < 50 ms)`);
    ok(long.longMs < 1500, `little main-thread blocking during the run (${long.longMs} ms of long tasks)`);
    const worst = Object.entries(results).sort((a, b) => b[1].busy - a[1].busy)[0];
    ok(worst[1].busy < 8, `idle right pane keeps the main thread under 8% busy (worst: ${worst[0]} ${worst[1].busy.toFixed(1)}%)`);
    ok(Object.values(results).every((r) => r.long === 0), "no long tasks (>50 ms) while idle");
    ok(Object.values(results).every((r) => r.reqs <= 25), "at most ~1 request/second while idle", JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.reqs]))));
    screen("pane-perf.png");
  } catch (err) {
    failures++; console.error("HARNESS ERROR:", err.stack ?? err.message);
    screen("handoff-error.png");
  } finally {
    await app?.close().catch(() => {});
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-1500));
  console.log(`\nScreens: ${OUT}`);
  console.log(failures === 0 ? "\nPANE PERF: PASS" : `\nPANE PERF: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
