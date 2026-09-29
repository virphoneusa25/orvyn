// scripts/acceptance/models-catalog.mjs
//
// ORVYN Cloud model catalog over the real API:
//   1. A customer sees six ORVYN models by name; no vendor, registry id or
//      endpoint appears anywhere in the models API, run events or usage.
//   2. ORVYN's models can't be edited, removed, tested or re-routed.
//   3. A customer connects their own model (key sealed at rest, never
//      returned), sets it as the default, and "Auto" runs on it — without
//      spending ORVYN credits. Clearing the default returns to ORVYN.
//
// Usage (after `npm run build -w @orvyn/backend`): node scripts/acceptance/models-catalog.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PORT = 4851, PLATFORM_PORT = 4852, OWN_PORT = 4853;
const BASE = `http://127.0.0.1:${PORT}`;
const PLATFORM_ID = "nebius:zai-org/GLM-5.3-Flash";
const OWN_KEY = "sk-own-model-SECRET-123";
const repoRoot = resolve(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..", "..");
const backendCwd = join(repoRoot, "apps", "backend");
const dataDir = mkdtempSync(join(tmpdir(), "orvyn-cat-data-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (c, label, detail = "") => { console.log(`${c ? "  PASS" : "  FAIL"}  ${label}${!c && detail ? `\n        ${detail}` : ""}`); if (!c) failures++; return c; };
const VENDOR = /nebius|fireworks|cheaperinference|openrouter|zai-org|GLM-5|api\.studio|endpoint/i;

function modelServer(reply, seenAuth) {
  return createServer((req, res) => {
    let raw = ""; req.on("data", (d) => (raw += d));
    req.on("end", () => {
      if (seenAuth) seenAuth.push(req.headers.authorization ?? "");
      if (req.url?.includes("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [{ id: "x" }] })); }
      let body = {}; try { body = JSON.parse(raw || "{}"); } catch {}
      const usage = { prompt_tokens: 30, completion_tokens: 6, total_tokens: 36 };
      if (!body.stream) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage })); }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
}
const ownAuth = [];
const platform = modelServer("Answer from ORVYN.");
const own = modelServer("FROM-MY-OWN-MODEL", ownAuth);

const call = async (path, method = "GET", body, token) => {
  const r = await fetch(`${BASE}/api/v1${path}`, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = {}; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, json, text };
};
async function runTask(token, instruction, requestedModelId) {
  const started = await call("/agent/stream/runs", "POST", { instruction, mode: "ask", composerMode: "auto", executionTarget: "auto", ...(requestedModelId ? { requestedModelId } : {}) }, token);
  const runId = started.json.runId;
  if (!runId) return { status: `start failed ${started.status} ${started.text.slice(0, 200)}`, text: "" };
  for (let i = 0; i < 160; i++) {
    const r = await call(`/agent/stream/runs/${runId}/events.json`, "GET", null, token);
    if (["completed", "error", "cancelled", "blocked", "failed"].includes(r.json.status)) return { status: r.json.status, text: r.text, events: r.json.events };
    await sleep(250);
  }
  return { status: "timeout", text: "" };
}

async function main() {
  await new Promise((r) => platform.listen(PLATFORM_PORT, "127.0.0.1", r));
  await new Promise((r) => own.listen(OWN_PORT, "127.0.0.1", r));
  const env = {
    ...process.env, ORVYN_DATA_DIR: dataDir, ORVYN_PROJECTS_DIR: mkdtempSync(join(tmpdir(), "orvyn-cat-proj-")), PORT: String(PORT),
    ORVYN_CLOUD_MODE: "true", ORVYN_REQUIRE_EMAIL_VERIFICATION: "false", ORVYN_PUBLIC_ORIGIN: BASE,
    ORVYN_VAULT_KEY: Buffer.alloc(32, 9).toString("base64"), ORVYN_TEST_ALLOW_PRIVATE_MODEL_ENDPOINTS: "1",
    MODEL_API_KEY: "platform-key", OPENAI_BASE_URL: `http://127.0.0.1:${PLATFORM_PORT}`, OPENAI_MODEL: PLATFORM_ID, OPENAI_CODE_MODEL: PLATFORM_ID,
  };
  delete env.ORVYN_API_KEY; delete env.NODE_ENV;
  for (const k of ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "FIREWORKS_API_KEY", "MISTRAL_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "CHEAPER_INFERENCE_API_KEY", "NEBIUS_API_KEY", "DEEPSEEK_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_MODEL", "OLLAMA_HOST", "STRIPE_SECRET_KEY"]) env[k] = "";
  const server = spawn(process.execPath, ["dist/index.js"], { cwd: backendCwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const log = []; server.stdout.on("data", (d) => log.push(String(d))); server.stderr.on("data", (d) => log.push(String(d)));
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/api/v1/health`)).ok) break; } catch {} await sleep(250); }
    const reg = await call("/auth/register", "POST", { name: "Cat", email: "cat@example.com", password: "a-long-password-9" });
    const T = reg.json.token;
    await call("/onboarding/provision", "POST", {}, T);
    await call("/onboarding", "PUT", { step: "complete", completed: ["first_mission"] }, T);

    console.log("\n1. The catalog");
    const models = await call("/models", "GET", null, T);
    const names = (models.json.models ?? []).filter((m) => m.kind === "orvyn").map((m) => m.name);
    ok(models.json.catalog === true && names.join(",") === "Auto,Fast,Reasoning,Code,Research,Vision", "six ORVYN models by name", names.join(","));
    ok(!VENDOR.test(models.text), "no vendor, registry id or endpoint in the models API", models.text.slice(0, 300));
    for (const path of ["/models/roles", "/models/providers/health", "/routing"]) {
      const r = await call(path, "GET", null, T);
      ok(!VENDOR.test(r.text), `nothing vendor-specific in ${path}`, r.text.slice(0, 200));
    }

    console.log("\n2. ORVYN's models are fixed");
    const enc = encodeURIComponent(PLATFORM_ID);
    const put = await call(`/models/${enc}`, "PUT", { name: "hijack", provider: "openai-compatible", endpoint: "https://evil.example" }, T);
    const del = await call(`/models/${enc}`, "DELETE", null, T);
    const test = await call(`/models/${enc}/test`, "POST", {}, T);
    const route = await call("/routing", "POST", { task: "chat", modelId: PLATFORM_ID }, T);
    ok([put.status, del.status, test.status, route.status].every((s) => s === 403), "edit, remove, test and re-route are refused (403)", `${put.status} ${del.status} ${test.status} ${route.status}`);
    const hijackId = await call("/models", "POST", { id: PLATFORM_ID, name: "x", endpoint: `http://127.0.0.1:${OWN_PORT}`, apiModelId: "x" }, T);
    ok(hijackId.json.model?.id?.startsWith("my:"), "adding a model can't take an ORVYN model's id", JSON.stringify(hijackId.json));
    if (hijackId.json.model?.id) await call(`/models/${encodeURIComponent(hijackId.json.model.id)}`, "DELETE", null, T);

    console.log("\n3. A run on ORVYN's routing");
    const w0 = (await call("/billing", "GET", null, T)).json.wallet.availableBalance;
    const a = await runTask(T, "Say hello");
    ok(a.status === "completed" && /Answer from ORVYN/.test(a.text), "Auto answers from ORVYN's model", a.status);
    ok(!VENDOR.test(a.text.replace(/Answer from ORVYN\./g, "")), "run events name no vendor or registry id", (a.text.match(VENDOR) ?? [])[0]);
    const w1 = (await call("/billing", "GET", null, T)).json.wallet.availableBalance;
    ok(w1 < w0, "ORVYN's model spends credits", `${w0} → ${w1}`);
    const stats = await call("/billing/stats", "GET", null, T);
    ok(!VENDOR.test(stats.text), "usage by model/provider names no vendor", stats.text.slice(0, 200));

    console.log("\n4. The customer's own model");
    const added = await call("/models", "POST", { name: "My Llama", endpoint: `http://127.0.0.1:${OWN_PORT}/v1`, apiModelId: "llama-3.3-70b", apiKey: OWN_KEY, capabilities: { tools: true } }, T);
    const id = added.json.model?.id;
    ok(added.status === 201 && id === "my:my-llama" && added.json.model.hasApiKey === true && !added.text.includes(OWN_KEY), "connected as my:my-llama; the key is never returned", added.text.slice(0, 300));
    const listed = await call("/models", "GET", null, T);
    ok(listed.json.models.some((m) => m.id === id && m.kind === "user" && m.endpoint === `http://127.0.0.1:${OWN_PORT}`) && !listed.text.includes(OWN_KEY), "listed under Your models with its address, without its key");
    const dbFiles = readdirSync(dataDir, { recursive: true }).map(String).filter((f) => /\.(db|sqlite)(-wal|-shm)?$|\.jsonl?$/.test(f));
    ok(dbFiles.length > 0 && dbFiles.every((f) => !readFileSync(join(dataDir, f)).includes(OWN_KEY)), "the key is sealed at rest (not in any database, WAL or log file)", dbFiles.filter((f) => readFileSync(join(dataDir, f)).includes(OWN_KEY)).join(","));
    const pref = await call("/models/preferred", "PUT", { modelId: id }, T);
    ok(pref.json.preferredModelId === id, "set as the default");
    const b = await runTask(T, "Say hello again");
    ok(b.status === "completed" && /FROM-MY-OWN-MODEL/.test(b.text), "Auto now runs on the customer's model", b.status);
    ok(ownAuth.some((h) => h === `Bearer ${OWN_KEY}`), "…with the customer's own key");
    const w2 = (await call("/billing", "GET", null, T)).json.wallet.availableBalance;
    ok(w2 === w1, "…and spends no ORVYN credits", `${w1} → ${w2}`);
    const pinnedOrvyn = await runTask(T, "Quick question", "fast");
    ok(pinnedOrvyn.status === "completed" && /Answer from ORVYN/.test(pinnedOrvyn.text), "choosing Fast still uses ORVYN", pinnedOrvyn.status);
    await call("/models/preferred", "PUT", { modelId: null }, T);
    const c = await runTask(T, "And once more");
    ok(c.status === "completed" && /Answer from ORVYN/.test(c.text), "clearing the default returns Auto to ORVYN", c.status);
    const edit = await call(`/models/${encodeURIComponent(id)}`, "PUT", { name: "My Llama", endpoint: `http://127.0.0.1:${OWN_PORT}`, apiModelId: "llama-3.3-8b" }, T);
    ok(edit.status === 200 && edit.json.model.apiModelId === "llama-3.3-8b" && edit.json.model.hasApiKey === true, "the customer edits their model; the saved key is kept", edit.text.slice(0, 200));
    const rm = await call(`/models/${encodeURIComponent(id)}`, "DELETE", null, T);
    ok(rm.status === 204, "…and can remove it");
  } catch (e) {
    failures++; console.error("HARNESS ERROR:", e.stack ?? e.message);
  } finally {
    server.kill("SIGKILL"); platform.close(); own.close();
  }
  if (failures) console.log("--- server log (tail) ---\n" + log.join("").slice(-2500));
  console.log(failures === 0 ? "\nMODELS CATALOG: PASS" : `\nMODELS CATALOG: FAIL (${failures} check(s))`);
  setTimeout(() => process.exit(failures === 0 ? 0 : 1), 200);
}
main();
