// scripts/acceptance/tenant-isolation.mjs
//
// Multi-tenant workspace isolation over the real HTTP API (ORVYN Cloud mode,
// real accounts, two customers on one host):
//   1. Customer A: "Build a website" from Home (no project open) → ORVYN
//      provisions A's workspace FIRST; the run writes index.html there; the
//      run's session event carries the workspace root; A's Files lists it.
//   2. Customer B can never reach A: not A's files (list/read) by path, not
//      A's workspace adopted as B's run project, not A's session, run events
//      or artifacts, not the data directory (auth.db) or a system path.
//   3. Research-only ("Explain how FreeSWITCH handles voicemail") provisions
//      no workspace.
//   4. Previews: the id is an HMAC (not derivable from ids a client sees),
//      the published site records its owner (tenant, workspace), and the
//      project folder behind it serves page assets only — not .json/.md/.txt.
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/tenant-isolation.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4831, MODEL_PORT = 4832;
const BASE = `http://127.0.0.1:${PORT}`;
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-iso-data-"));
const projectsDir = mkdtempSync(join(tmpdir(), "orvyn-iso-proj-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };

const HTML = '<!doctype html><html><head><title>Customer A Secret Site</title><link rel="stylesheet" href="styles.css"></head><body><h1>A only</h1><main><p>Customer A private content for the isolation test, long enough to count as a page with real words in it for the render check.</p></main></body></html>';
const CSS = "body{background:#123;color:#fff}";
const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join(" ") : "");

function nextTurn(body) {
  const msgs = body.messages ?? [];
  const system = String(msgs[0]?.content ?? "");
  const tools = (body.tools ?? []).map((t) => t.function?.name ?? t.name);
  if (system.includes("ORVYN VERIFIER")) {
    const url = (system.match(/Published page: (\S+)/) ?? [])[1];
    const got = msgs.filter((m) => m.role === "tool").length;
    if (url && got === 0 && tools.includes("browser_open")) return { call: { name: "browser_open", args: { url } } };
    return { text: "VERDICT: PASS\n- The page and its stylesheet are there." };
  }
  if (system.includes("You maintain a short memory")) return { text: '{"add":[],"update":[],"remove":[]}' };
  const first = msgs.filter((m) => m.role === "user").map((m) => textOf(m.content)).find((u) => /Build|Explain|List/.test(u)) ?? "";
  const n = msgs.filter((m) => m.role === "tool").length;
  if (/Build me a website/.test(first) && tools.includes("write_file")) {
    if (n === 0) return { call: { name: "write_file", args: { path: "index.html", content: HTML } } };
    if (n === 1) return { call: { name: "write_file", args: { path: "styles.css", content: CSS } } };
    if (n === 2) return { call: { name: "write_file", args: { path: "notes.md", content: "A-PRIVATE planning notes" } } };
    return { text: "Built the site." };
  }
  if (/List the files/.test(first) && tools.includes("list_directory")) {
    if (n === 0) return { call: { name: "list_directory", args: { path: "." } } };
    return { text: `Files: ${textOf(msgs.filter((m) => m.role === "tool").pop()?.content)}` };
  }
  return { text: "FreeSWITCH stores voicemail via mod_voicemail." };
}

let seq = 0;
const model = createServer((req, res) => {
  let raw = ""; req.on("data", (d) => (raw += d));
  req.on("end", () => {
    if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "scripted-agent" }] })); }
    let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
    const turn = nextTurn(body);
    const calls = turn.call ? [{ index: 0, id: `call_${++seq}`, type: "function", function: { name: turn.call.name, arguments: JSON.stringify(turn.call.args) } }] : undefined;
    const usage = { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 };
    if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: turn.text ?? "", tool_calls: calls }, finish_reason: calls ? "tool_calls" : "stop" }], usage })); }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (turn.text) send({ choices: [{ index: 0, delta: { content: turn.text } }] });
    if (calls) send({ choices: [{ index: 0, delta: { tool_calls: calls } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: calls ? "tool_calls" : "stop" }], usage });
    res.end("data: [DONE]\n\n");
  });
});

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
async function runTask(token, instruction, extra = {}) {
  const started = await call("/agent/stream/runs", "POST", { instruction, executionTarget: "auto", composerMode: "auto", mode: "agent", permissionMode: "full_access", ...extra }, token);
  const runId = started.json.runId;
  if (!runId) return { status: `start failed ${started.status} ${started.text.slice(0, 200)}`, events: [], sessionId: null };
  let last = null;
  for (let i = 0; i < 240; i++) {
    const r = await call(`/agent/stream/runs/${runId}/events.json`, "GET", null, token);
    last = r;
    if (["completed", "error", "cancelled", "blocked", "failed"].includes(r.json.status)) return { runId, status: r.json.status, events: r.json.events ?? [], sessionId: started.json.sessionId };
    await sleep(250);
  }
  return { runId, status: `timeout (last ${last?.status} ${String(last?.json?.status)} ${JSON.stringify((last?.json?.events ?? []).slice(-4).map((e) => e.type))})`, events: last?.json?.events ?? [], sessionId: started.json.sessionId };
}
const flat = (tree) => JSON.stringify(tree);

async function main() {
  await new Promise((r) => model.listen(MODEL_PORT, "127.0.0.1", r));
  const M = `http://127.0.0.1:${MODEL_PORT}`;
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: projectsDir, PORT: String(PORT), ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false",
    ORVYN_VAULT_KEY: Buffer.alloc(32, 7).toString("base64"), ORVYN_PUBLIC_ORIGIN: `http://127.0.0.2:${PORT}`,
    MODEL_API_KEY: "scripted", OPENAI_BASE_URL: M, OPENAI_MODEL: "scripted-agent", OPENAI_CODE_MODEL: "scripted-agent",
  };
  delete env.ORVYN_API_KEY;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    const A = (await call("/auth/register", "POST", { name: "Alice", email: "alice@a.example", password: "customer-a-password" })).json.token;
    const B = (await call("/auth/register", "POST", { name: "Bob", email: "bob@b.example", password: "customer-b-password" })).json.token;
    ok(Boolean(A && B), "two customers signed up (each with a Personal Organization)");
    await call("/onboarding/provision", "POST", {}, A);
    await call("/onboarding/provision", "POST", {}, B);

    console.log("\n1. Customer A builds from Home (no project open)");
    const a = await runTask(A, "Build me a website for my company");
    const resolved = [...a.events].reverse().find((e) => e.type === "workspace.resolved")?.data;
    const session = a.events.find((e) => e.type === "run.session")?.data;
    const rootA = String(resolved?.projectRoot ?? "");
    ok(a.status === "completed", "A's run finished", `${a.status} ${JSON.stringify(a.events.filter((e) => /error/.test(e.type)).map((e) => e.data).slice(-2))}`);
    ok(Boolean(resolved?.workspaceId) && /tenants[\\/]+user_[^\\/]+[\\/]+workspaces[\\/]+ws_/.test(rootA), "a workspace was provisioned for A before the work, under A's tenant", rootA);
    ok(existsSync(join(rootA, "index.html")) && existsSync(join(rootA, "styles.css")), "the files are in A's workspace (durable, not the preview)");
    ok(session?.projectRoot === rootA && session?.workspaceId === resolved?.workspaceId, "run.session carries the workspace root (the Files pane binds to it)", JSON.stringify(session));
    const filesA = await call(`/files?projectRoot=${encodeURIComponent(rootA)}&sessionId=${a.sessionId}`, "GET", null, A);
    ok(/index\.html/.test(flat(filesA.json)) && /styles\.css/.test(flat(filesA.json)), "A's Files lists index.html and styles.css from A's workspace", flat(filesA.json).slice(0, 300));
    const readA = await call(`/files/read?projectRoot=${encodeURIComponent(rootA)}&path=index.html`, "GET", null, A);
    ok(/Customer A Secret Site/.test(String(readA.json.content ?? "")), "A can read its own file");

    console.log("\n2. Customer B cannot reach A");
    const filesB = await call(`/files?projectRoot=${encodeURIComponent(rootA)}`, "GET", null, B);
    ok(!/index\.html|notes\.md/.test(flat(filesB.json)), "B listing A's workspace path gets B's own (empty) workspace, not A's files", flat(filesB.json).slice(0, 300));
    const readB = await call(`/files/read?projectRoot=${encodeURIComponent(rootA)}&path=index.html`, "GET", null, B);
    ok(!/Customer A Secret Site/.test(readB.text), "B cannot read A's index.html", readB.text.slice(0, 200));
    const readSecret = await call(`/files/read?projectRoot=${encodeURIComponent(rootA)}&path=notes.md`, "GET", null, B);
    ok(!/A-PRIVATE/.test(readSecret.text), "B cannot read A's notes.md");
    const readAuth = await call(`/files/read?projectRoot=${encodeURIComponent(dataDir)}&path=auth.db`, "GET", null, B);
    ok(!/SQLite format|users/.test(readAuth.text) && readAuth.status !== 200 || !readAuth.json.content, "B cannot read the data directory (auth.db)", `${readAuth.status} ${readAuth.text.slice(0, 120)}`);
    const readEtc = await call(`/files/read?projectRoot=${encodeURIComponent("/etc")}&path=passwd`, "GET", null, B);
    ok(!/root:x:0:0/.test(readEtc.text), "B cannot read /etc/passwd through a projectRoot");
    const b = await runTask(B, "List the files in this project", { projectRoot: rootA });
    const rootB = String([...b.events].reverse().find((e) => e.type === "workspace.resolved")?.data?.projectRoot ?? "");
    const listing = JSON.stringify(b.events.filter((e) => e.type === "tool.completed").map((e) => e.data?.output ?? e.data?.result ?? ""));
    ok(rootB !== rootA && !/index\.html|notes\.md/.test(listing), "B's run naming A's workspace path does NOT adopt it (B works in its own)", `${rootB} ${listing.slice(0, 200)}`);
    const sessB = await call(`/sessions/${a.sessionId}`, "GET", null, B);
    ok(sessB.status === 404 || !sessB.json.session, "B cannot open A's conversation", `${sessB.status}`);
    const evB = await call(`/agent/stream/runs/${a.runId}/events.json`, "GET", null, B);
    ok(evB.status === 404 || !(evB.json.events ?? []).length, "B cannot read A's run events", `${evB.status}`);
    const idx = await call("/index/build", "POST", { projectRoot: rootA, wait: true }, B);
    const search = await call("/search/semantic", "POST", { query: "Customer A Secret Site", projectRoot: rootA }, B);
    ok(!/Customer A Secret Site|A-PRIVATE/.test(idx.text + search.text), "B cannot index or search A's workspace", `${idx.status} ${search.status}`);

    console.log("\n3. Research-only needs no workspace");
    const r = await runTask(B, "Explain how FreeSWITCH handles voicemail.");
    if (r.status !== "completed") console.log("   research events:", JSON.stringify(r.events.slice(-8).map((e) => [e.type, JSON.stringify(e.data).slice(0, 160)])));
    ok(r.status === "completed" && !r.events.some((e) => e.type === "workspace.resolved"), "no workspace provisioned for a question", r.status);

    console.log("\n4. Previews");
    const url = String([...a.events].reverse().find((e) => e.type === "preview.available" || e.type === "preview.updated")?.data?.url ?? "");
    const id = (url.match(/\/sites\/([\w-]+)\//) ?? [])[1] ?? "";
    ok(Boolean(id), "A's site has a preview", url);
    const { createHash } = await import("node:crypto");
    const guess = (key) => { const h = createHash("sha256").update(`orvyn-preview:${key}`).digest("hex"); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
    ok(id && id !== guess(`ws:${resolved?.workspaceId}`) && !id.includes(String(resolved?.workspaceId)), "the preview id is not derivable from the workspace id a client has seen");
    const roots = JSON.parse(readFileSync(join(dataDir, "previews", "roots.json"), "utf8"));
    ok(roots[id]?.owner?.tenantId?.startsWith("user_") && roots[id]?.owner?.workspaceId === resolved?.workspaceId, "the published site records its owner (tenant + workspace)", JSON.stringify(roots[id]?.owner ?? null));
    const secret = await fetch(`${BASE}/api/v1/sites/${id}/notes.md`);
    ok(secret.status === 404 || !/A-PRIVATE/.test(await secret.text()), "the preview does not expose the project's data files (notes.md)", String(secret.status));
    const css = await fetch(`${BASE}/api/v1/sites/${id}/styles.css`);
    ok(css.status === 200, "…while page assets (styles.css) are served");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); model.close();
  }
  if (failures) console.log("--- control plane log (tail) ---\n" + log.join("").slice(-3500));
  console.log(failures === 0 ? "\nTENANT ISOLATION: PASS" : `\nTENANT ISOLATION: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
}
main();
