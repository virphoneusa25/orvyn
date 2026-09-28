// scripts/acceptance/hero-mission.mjs
//
// The production scenario from Sep 28 (VirPhone site in orvyn-desktop-fixture):
//
//   A. "Can you add an animated hero background?"
//      - ORION first asks search_capabilities for "edit the VirPhone website
//        files" (what the model did in production): resolved as NATIVE core
//        tools — no capability.required, no "Find a tool" card.
//      - The run gets a capability manifest (files writable, shell, git…).
//      - It inspects index.html, writes assets/hero-waves.svg, adds the
//        animation to styles.css.
//      - The preview check loads index.html, styles.css, script.js and the
//        hero asset (200, right MIME) and, in a real browser, the page is
//        styled (body background is not white).
//      - Verify passes; run.outcome "complete"; Changes counts come from the
//        real file diffs.
//   B. Root-absolute links ("/styles.css") resolve inside the preview.
//   C. Broken stylesheet: the page links css/missing.css and the model never
//      fixes it → preview.failed naming the file, completion blocked for
//      repair, final outcome "partial" (never a green Preview/Verify).
//   D. "Edit the homepage heading" → native tools, no card. "Update the
//      Salesforce CRM record" → the install card (a real external need).
//   E. Workspace writes switched off → "ORVYN needs permission to modify this
//      workspace.", not an MCP card.
//   F. Chat: "?" after the hero request → handed to a task with the hero
//      request as its instruction (no card); start_project_task works too.
//
// Usage (after `npm run build -w @orvyn/backend`):
//   node scripts/acceptance/hero-mission.mjs     (HERO_SHOTS=dir to keep the screenshot)

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const PORT = 4791, MODEL_PORT = 4792;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const fixture = join(repoRoot, "scripts", "acceptance", "fixtures", "virphone-site");
const work = mkdtempSync(join(tmpdir(), "orvyn-hero-"));
const dataDir = join(work, "data");
const shots = process.env.HERO_SHOTS || join(work, "shots");
mkdirSync(shots, { recursive: true });
const project = (name) => { const dir = join(work, name); cpSync(fixture, dir, { recursive: true }); return dir; };

const HERO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 600" preserveAspectRatio="none"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#3b82f6" stop-opacity=".35"/><stop offset="1" stop-color="#60a5fa" stop-opacity=".1"/></linearGradient></defs><path d="M0 400 C 360 300 720 500 1440 380 L1440 600 L0 600 Z" fill="url(#g)"/><path d="M0 460 C 400 380 800 560 1440 440 L1440 600 L0 600 Z" fill="#3b82f6" fill-opacity=".12"/></svg>`;
const HERO_CSS = `
/* Animated hero background */
.hero { position: relative; overflow: hidden; isolation: isolate; }
.hero::before {
  content: "";
  position: absolute; inset: -20% -10%;
  z-index: -1;
  background: url("assets/hero-waves.svg") repeat-x bottom / 1440px 600px;
  animation: hero-drift 18s linear infinite;
  opacity: .9;
}
@keyframes hero-drift { from { background-position-x: 0; } to { background-position-x: 1440px; } }
@media (prefers-reduced-motion: reduce) { .hero::before { animation: none; } }
`;

const seen = { capabilityNotes: [], chatNotes: [], toolsOffered: new Set() };
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  const results = msgs.filter((m) => m.role === "tool");
  const users = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const firstUser = users.find((u) => !/^(Budget note|\[)/.test(u)) ?? "";
  const lastUser = users[users.length - 1] ?? "";
  if (system.includes("ORVYN VERIFIER")) {
    const url = (system.match(/Published page: (\S+)/) ?? [])[1];
    if (url && results.length === 0 && tools.includes("browser_open")) return { call: { name: "browser_open", args: { url } } };
    if (url && results.length === 1 && tools.includes("browser_screenshot")) return { call: { name: "browser_screenshot", args: {} } };
    const broken = /missing\.css/.test(JSON.stringify(msgs));
    return { text: broken ? "VERDICT: FAIL\n- [blocker] The stylesheet css/missing.css does not load; the page is unstyled." : "VERDICT: PASS\n- The hero has the animated wave background (hero-drift keyframes, assets/hero-waves.svg) and the page is styled." };
  }
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  if (!tools.length) return { text: "OK." };
  for (const t of tools) seen.toolsOffered.add(t);
  if (tools.includes("write_file")) { const all = msgs.filter((m) => m.role === "system").map((m) => textOf(m.content)).join("\n"); const m = all.match(/CAPABILITIES \(facts from ORVYN[^\n]*\n[^\n]*/); if (m) seen.manifestInRun = m[0]; else seen.noManifestSystem = all.slice(0, 200); }

  // ---- chat surface (no file tools) ----
  if (!tools.includes("write_file")) {
    if (/^\?$/.test(lastUser.trim())) {
      if (!results.length) return { call: { name: "search_capabilities", args: { query: "this task" } } };
      seen.chatNotes.push(textOf(results[0].content));
      return { text: "On it." };
    }
    if (/make the footer darker/i.test(lastUser)) {
      if (!results.length) return { call: { name: "start_project_task", args: { instruction: "Make the footer background darker in styles.css" } } };
      seen.chatNotes.push(textOf(results[0].content));
      return { text: "Doing it now." };
    }
    return { text: "OK." };
  }

  // ---- task runs ----
  const last = results[results.length - 1];
  const lastText = textOf(last?.content);
  if (/PREVIEW CHECK FAILED/.test(lastUser) && /Change the stylesheet link/.test(firstUser)) return { text: "I looked at it; the link is what you asked for." };
  if (/animated hero background/i.test(firstUser)) {
    const step = results.length;
    if (step === 0) return { text: "", call: { name: "search_capabilities", args: { query: "edit the VirPhone website files, add the animated hero background and verify the published preview" } } };
    if (step === 1) { seen.capabilityNotes.push(lastText); return { text: "Looking at the page.", call: { name: "read_file", args: { path: "index.html" } } }; }
    if (step === 2) return { text: "Adding the hero artwork.", call: { name: "write_file", args: { path: "assets/hero-waves.svg", content: HERO_SVG } } };
    if (step === 3) return { text: "", call: { name: "read_file", args: { path: "styles.css" } } };
    if (step === 4) return { text: "Animating it.", call: { name: "edit_file", args: { path: "styles.css", old_string: "/* Hero */", new_string: `/* Hero */${HERO_CSS}` } } };
    return { text: "The hero now has an animated wave background (assets/hero-waves.svg drifting with the hero-drift keyframes), and it respects reduced motion." };
  }
  if (/Use an absolute stylesheet path/i.test(firstUser)) {
    if (results.length === 0) return { call: { name: "edit_file", args: { path: "index.html", old_string: '<link rel="stylesheet" href="styles.css">', new_string: '<link rel="stylesheet" href="/styles.css">' } } };
    if (results.length === 1) return { call: { name: "edit_file", args: { path: "styles.css", old_string: "/* Hero */", new_string: "/* Hero */\n.hero-art { background-image: url(/hero-bg.svg); }" } } };
    return { text: "The page now links /styles.css and the hero art uses /hero-bg.svg." };
  }
  if (/Change the stylesheet link/i.test(firstUser)) {
    if (results.length === 0) return { call: { name: "edit_file", args: { path: "index.html", old_string: '<link rel="stylesheet" href="styles.css">', new_string: '<link rel="stylesheet" href="css/missing.css">' } } };
    return { text: "Done — the page links css/missing.css." };
  }
  if (/Edit the homepage heading/i.test(firstUser)) {
    if (results.length === 0) return { call: { name: "search_capabilities", args: { query: "edit the homepage heading" } } };
    if (results.length === 1) { seen.capabilityNotes.push(lastText); return { call: { name: "edit_file", args: { path: "index.html", old_string: "Wholesale VoIP Carrier You Can Trust", new_string: "Global voice traffic, terminated with precision." } } }; }
    return { text: "The heading now reads “Global voice traffic, terminated with precision.”" };
  }
  if (/Salesforce/i.test(firstUser)) {
    if (results.length === 0) return { call: { name: "search_capabilities", args: { query: "update a Salesforce CRM record" } } };
    seen.capabilityNotes.push(lastText);
    return { text: "I need a Salesforce connector to update that record; approve it on the card and I'll finish." };
  }
  if (/Tweak the hero padding/i.test(firstUser)) {
    if (results.length === 0) return { call: { name: "search_capabilities", args: { query: "edit styles.css in the project" } } };
    seen.capabilityNotes.push(lastText);
    return { text: "ORVYN needs permission to modify this workspace." };
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
    const toolCalls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text ?? "", tool_calls: toolCalls }, finish_reason: toolCalls ? "tool_calls" : "stop" }], usage })); }
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
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

async function runTask(instruction, projectRoot, extra = {}) {
  const started = await api("/agent/stream/runs", "POST", { instruction, projectRoot, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access", ...extra });
  const runId = started.json.runId;
  if (!runId) return { runId, status: `start failed ${started.status}: ${JSON.stringify(started.json).slice(0, 300)}`, events: [] };
  for (let i = 0; i < 480; i++) {
    const r = await api(`/agent/stream/runs/${runId}/events.json`);
    if (["completed", "error", "cancelled", "blocked", "failed"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [], sessionId: started.json.sessionId };
    await sleep(250);
  }
  return { runId, status: "timeout", events: [] };
}
const of = (run, type) => run.events.filter((e) => e.type === type);
const lastOf = (run, ...types) => [...run.events].reverse().find((e) => types.includes(e.type));
const previewUrl = (run) => String(lastOf(run, "preview.updated", "preview.available")?.data?.url ?? "");

async function stages(events, status) {
  const { deriveMissionStages } = await import(join(repoRoot, "apps", "desktop", "src", "renderer", "missionPhases.ts"));
  return Object.fromEntries(deriveMissionStages(events, status).stages.map((s) => [s.name, s.state]));
}

async function screenshot(url, file) {
  try {
    // The backend's Playwright (its browsers are the ones installed with it).
    const { chromium } = createRequire(join(backendCwd, "package.json"))("playwright");
    const b = await chromium.launch({ headless: true }).catch(() => chromium.launch({ headless: true, executablePath: "/opt/pw-browsers/chromium" }))
      .catch(() => chromium.launch({ headless: true, channel: "chrome" }));
    const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto(url, { waitUntil: "load" });
    const info = await p.evaluate(() => {
      const hero = document.querySelector(".hero");
      const before = hero ? getComputedStyle(hero, "::before") : null;
      return { bg: getComputedStyle(document.body).backgroundColor, heroAnim: before?.animationName ?? "", heroBg: before?.backgroundImage ?? "", heroVisible: Boolean(hero && hero.getBoundingClientRect().height > 100) };
    });
    await p.screenshot({ path: file });
    await b.close();
    return info;
  } catch (e) { return { error: String(e.message ?? e) }; }
}

async function chatTurn(history, userMessage) {
  return new Promise((resolveChat) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws/chat`);
    const acts = [];
    sock.onopen = () => sock.send(JSON.stringify({ task: "chat", history, userMessage, context: { useRag: false } }));
    sock.onmessage = (ev) => { const c = JSON.parse(ev.data); if (c.activity) acts.push(c.activity); if (c.done) { sock.close(); resolveChat(acts); } };
    sock.onerror = () => resolveChat(acts);
    setTimeout(() => resolveChat(acts), 20000);
  });
}

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, PORT: String(PORT), ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"),
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_CLOUD_MODE; delete env.ORVYN_PROJECTS_DIR; delete env.ORVYN_API_KEY;
  for (const k of ["FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }

    console.log("\nA. “Can you add an animated hero background?” in the VirPhone project");
    const heroDir = project("hero");
    const hero = await runTask("Can you add an animated hero background?", heroDir);
    ok(hero.status === "completed", "the run finished", `${hero.status} ${JSON.stringify(hero.events.filter((e) => /error|failed|blocked/.test(e.type)).map((e) => [e.type, e.data?.message ?? e.data?.error ?? e.data?.reasons]).slice(-5))}`);
    const manifest = of(hero, "capability.manifest")[0]?.data;
    ok(manifest?.workspace?.readable && manifest?.workspace?.writable && manifest?.workspace?.shell, "the run got a real capability manifest (read, write, shell)", JSON.stringify(manifest?.workspace));
    ok(/create\/edit\/delete files yes/.test(seen.manifestInRun ?? ""), "the model was told its capabilities as facts", String(seen.manifestInRun ?? seen.noManifestSystem));
    const resolved = of(hero, "capability.resolved")[0]?.data;
    ok(resolved?.kind === "native", "“edit the VirPhone website files” resolved to ORVYN core tools", JSON.stringify(resolved));
    ok(of(hero, "capability.required").length === 0, "NO MCP request / “Find a tool” card");
    ok(/core tools for this: .*edit_file.*need no install/i.test(seen.capabilityNotes[0] ?? ""), "ORION was told to use its own core tools (no install)", seen.capabilityNotes[0]);
    ok(hero.events.some((e) => e.type === "tool.completed" && e.data?.tool === "read_file"), "ORION inspected the page first");
    const css = readFileSync(join(heroDir, "styles.css"), "utf8");
    ok(css.includes("@keyframes hero-drift") && existsSync(join(heroDir, "assets", "hero-waves.svg")), "the project files really changed: hero asset created, CSS animation added");
    const url = previewUrl(hero);
    ok(/\/api\/v1\/sites\/[\w-]+\/$/.test(url), "a live preview exists", url);
    const pv = lastOf(hero, "preview.verified", "preview.failed");
    ok(pv?.type === "preview.verified", "the preview check passed", JSON.stringify(pv?.data?.issues));
    const assets = pv?.data?.assets ?? [];
    const asset = (re) => assets.find((a) => re.test(a.path));
    ok(asset(/styles\.css$/)?.status === 200 && /text\/css/.test(asset(/styles\.css$/)?.contentType), "styles.css → 200 text/css", JSON.stringify(asset(/styles\.css$/)));
    ok(asset(/script\.js$/)?.status === 200 && /javascript/.test(asset(/script\.js$/)?.contentType), "script.js → 200 text/javascript", JSON.stringify(asset(/script\.js$/)));
    ok(asset(/hero-waves\.svg$/)?.status === 200 && /image\/svg\+xml/.test(asset(/hero-waves\.svg$/)?.contentType), "assets/hero-waves.svg (from the stylesheet) → 200 image/svg+xml", JSON.stringify(assets.map((a) => [a.path.split("/").pop(), a.status])));
    const indexRes = await fetch(url);
    ok(indexRes.status === 200 && /text\/html/.test(indexRes.headers.get("content-type") ?? ""), "index.html → 200 text/html");
    const b = pv?.data?.browser;
    if (b?.ran) {
      ok(b.bodyBackground && b.bodyBackground !== "rgb(255, 255, 255)" && !b.defaultStyles, "in a real browser the body is styled (not white)", JSON.stringify(b));
      ok((b.failedRequests ?? []).length === 0 && (b.pageErrors ?? []).length === 0, "no failed same-origin requests, no page errors", JSON.stringify(b));
    } else ok(false, "the browser check ran", JSON.stringify(b));
    const shot = await screenshot(url, join(shots, "hero-preview.png"));
    ok(shot.bg === "rgb(11, 15, 23)" && shot.heroAnim === "hero-drift" && /hero-waves\.svg/.test(shot.heroBg) && shot.heroVisible, "screenshot: the styled VirPhone site with the animated hero (body #0b0f17, .hero::before hero-drift)", JSON.stringify(shot));
    const verdict = lastOf(hero, "verification.completed")?.data?.verdict;
    ok(verdict === "PASS", "Verify: the independent verifier passed", String(verdict));
    const outcome = lastOf(hero, "run.outcome")?.data;
    ok(outcome?.outcome === "complete", "run.outcome: complete", JSON.stringify(outcome));
    const st = await stages(hero.events, hero.status);
    ok(st.Build === "done" && st.Preview === "done" && st.Verify === "done" && st.Complete === "done", "stages: Build ✓ Preview ✓ Verify ✓ Complete ✓", JSON.stringify(st));
    const edits = of(hero, "file.edit").map((e) => e.data?.preview).filter(Boolean);
    const added = edits.reduce((n, p) => n + (p.additions ?? p.stats?.additions ?? 0), 0);
    ok(added >= HERO_CSS.trim().split("\n").length, "the change count comes from the real diffs (CSS lines added + the new SVG)", `additions=${added}`);
    const completeAt = hero.events.findIndex((e) => e.type === "run.completed");
    const lastCheck = hero.events.findIndex((e) => e === pv);
    ok(completeAt > lastCheck && lastCheck > 0, "Complete came only after the preview and verification checks");

    console.log("\nB. Root-absolute links (“/styles.css”) resolve inside the preview");
    const absDir = project("absolute");
    const abs = await runTask("Use an absolute stylesheet path in index.html", absDir);
    const absUrl = previewUrl(abs);
    const absHtml = absUrl ? await (await fetch(absUrl)).text() : "";
    const link = /<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/.exec(absHtml)?.[1] ?? "";
    const cssUrl = link ? new URL(link, absUrl) : null;
    const absCss = cssUrl ? await fetch(cssUrl) : null;
    const absCssText = absCss?.ok ? await absCss.text() : "";
    ok(link !== "/styles.css" && absCss?.status === 200 && cssUrl.pathname.startsWith(new URL(absUrl).pathname), "the page's /styles.css loads from this site (200), not the server root", `${link} → ${cssUrl?.pathname} ${absCss?.status}`);
    const artUrl = /url\(([^)]*hero-bg\.svg)\)/.exec(absCssText)?.[1] ?? "";
    const art = artUrl ? await fetch(new URL(artUrl, cssUrl)) : null;
    ok(artUrl.startsWith(new URL(absUrl).pathname) && art?.status === 200 && /image\/svg\+xml/.test(art.headers.get("content-type") ?? ""), "url(/hero-bg.svg) in the stylesheet is served from this site (200 image/svg+xml)", `${artUrl} ${art?.status}`);
    ok(readFileSync(join(absDir, "index.html"), "utf8").includes('href="/styles.css"'), "the project's own file is unchanged (rewrite happens only when serving)");
    ok(lastOf(abs, "preview.verified", "preview.failed")?.type === "preview.verified", "the preview check passed", JSON.stringify(lastOf(abs, "preview.failed")?.data?.issues));

    console.log("\nC. Broken stylesheet: never a green Preview / Verify");
    const brokenDir = project("broken");
    const broken = await runTask("Change the stylesheet link in index.html to css/missing.css", brokenDir);
    const failedCheck = lastOf(broken, "preview.verified", "preview.failed");
    ok(failedCheck?.type === "preview.failed" && (failedCheck.data?.issues ?? []).some((i) => /missing\.css.*404/.test(i)), "preview.failed names the file: css/missing.css → 404", JSON.stringify(failedCheck?.data?.issues));
    ok(of(broken, "completion.blocked").some((e) => e.data?.gate === "preview"), "completion was blocked and the agent was sent back to fix it");
    const bOutcome = lastOf(broken, "run.outcome")?.data;
    ok(bOutcome?.outcome === "partial" || ["error", "failed"].includes(broken.status), "the mission ends Partial (or Failed), not Complete", `${broken.status} ${JSON.stringify(bOutcome)}`);
    const bst = await stages(broken.events, broken.status);
    ok(bst.Build === "done" && bst.Preview === "failed" && bst.Verify !== "done" && bst.Complete !== "done", "stages: Build ✓ Preview ⚠ Verify ⚠ — Complete is not green", JSON.stringify(bst));
    ok(broken.events.some((e) => (e.type === "conversation.message" || e.type === "message.final") && /Not fully done|missing\.css/.test(String(e.data?.content ?? ""))), "ORION says plainly what is not done");

    console.log("\nD. Native vs MCP");
    const headingDir = project("heading");
    const heading = await runTask("Edit the homepage heading to say Global voice traffic, terminated with precision.", headingDir);
    ok(of(heading, "capability.required").length === 0 && of(heading, "capability.resolved")[0]?.data?.kind === "native", "“Edit the homepage heading” → native tools, no MCP prompt", JSON.stringify(of(heading, "capability.resolved").map((e) => e.data)));
    ok(readFileSync(join(headingDir, "index.html"), "utf8").includes("terminated with precision"), "the heading really changed");
    const crm = await runTask("Update the Salesforce CRM record for Acme with today's call volume", project("crm"));
    ok(of(crm, "capability.required").length === 1 && of(crm, "capability.resolved")[0]?.data?.kind === "mcp", "an external service with no connector → the capability card (genuinely required)", JSON.stringify(of(crm, "capability.resolved").map((e) => e.data)));

    console.log("\nE. Workspace writes switched off → a permission message, not an MCP card");
    const ro = await runTask("Tweak the hero padding in styles.css", project("readonly"), { permissionMode: "ask", toolPermissions: { write_file: "denied", edit_file: "denied" } });
    const roResolved = of(ro, "capability.resolved")[0]?.data;
    if (roResolved?.kind === "permission") {
      ok(of(ro, "permission.required")[0]?.data?.message === "ORVYN needs permission to modify this workspace.", "“ORVYN needs permission to modify this workspace.”");
      ok(of(ro, "capability.required").length === 0, "no MCP card for a permission problem");
    } else {
      // This build has no per-run tool-permission override: check the rule directly.
      const { resolveCapabilityNeed, buildCapabilityManifest } = await import(join(backendCwd, "dist", "agent", "capabilityManifest.js"));
      const m = buildCapabilityManifest([{ name: "read_file" }, { name: "write_file" }, { name: "edit_file" }, { name: "terminal" }], (n) => (/write_file|edit_file/.test(n) ? "denied" : "allowed"));
      const need = resolveCapabilityNeed("edit styles.css in the project", m, () => true);
      ok(need.kind === "permission" && need.message === "ORVYN needs permission to modify this workspace.", "writes denied → “ORVYN needs permission to modify this workspace.” (not an MCP card)", JSON.stringify(need));
    }

    console.log("\nF. The chat: “?” after the hero request, and start_project_task");
    const acts = await chatTurn([{ role: "user", content: "Can you add an animated hero background?" }, { role: "assistant", content: "Sure." }], "?");
    const handoff = acts.find((a) => a.kind === "handoff");
    ok(Boolean(handoff) && !acts.some((a) => a.kind === "capability"), "“?” → handed to a task (no “Find a tool” card)", JSON.stringify(acts.map((a) => a.kind)));
    ok(handoff?.prompt === "Can you add an animated hero background?", "the task starts with the user's real request, not “?”", String(handoff?.prompt));
    const acts2 = await chatTurn([], "Make the footer darker please");
    const h2 = acts2.find((a) => a.kind === "handoff");
    ok(h2?.prompt === "Make the footer background darker in styles.css", "start_project_task hands the model's full instruction to a task", JSON.stringify(acts2));
    ok(seen.toolsOffered.has("start_project_task"), "the chat is offered start_project_task (its route to the core tools)");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  console.log(`\nScreenshot: ${join(shots, "hero-preview.png")}`);
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-3000));
  console.log(failures === 0 ? "\nHERO MISSION: PASS" : `\nHERO MISSION: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
