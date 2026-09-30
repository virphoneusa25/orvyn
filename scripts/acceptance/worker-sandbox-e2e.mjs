// scripts/acceptance/worker-sandbox-e2e.mjs
//
// Runs the REAL worker process (apps/worker/dist/index.js) against a small
// stand-in control plane and drives one mission end to end through the tool
// RPC channel: "Create test.txt containing hello", read it back, run a
// command, hit the network policy, get the change synced to the durable
// workspace, and see the sandbox removed. Works with either provider:
//
//   ORVYN_E2E_PROVIDER=docker    ORVYN_SANDBOX_IMAGE=<local image>
//   ORVYN_E2E_PROVIDER=openshell OPENSHELL_GATEWAY_URL=... OPENSHELL_TLS_*=... OPENSHELL_SANDBOX_IMAGE=...
//
//   npm run build -w @orvyn/worker && node scripts/acceptance/worker-sandbox-e2e.mjs

import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const provider = process.env.ORVYN_E2E_PROVIDER === "openshell" ? "openshell" : "docker";
const root = fs.mkdtempSync(path.join(process.env.ORVYN_E2E_ROOT || os.tmpdir(), "orvyn-e2e-"));
const workspaces = path.join(root, "workspaces");
fs.mkdirSync(workspaces, { recursive: true });
const runId = `run${Date.now().toString(36)}e2e`;
const sandboxId = `sbx_e2e${Date.now().toString(36)}`;
const canonical = { "README.md": "# demo\n" };
let synced = null;
const events = [];
const reports = [];
const results = new Map();
const script = [
  { tool: "write_file", arguments: { path: "test.txt", content: "hello" } },
  { tool: "read_file", arguments: { path: "test.txt" } },
  { tool: "terminal", arguments: { command: "cat /workspace/test.txt; echo; id -u" } },
  { tool: "terminal", arguments: { command: "exit 5" } },
  { tool: "terminal", arguments: { command: "curl -sS -m 8 https://registry.npmjs.org/ -o /dev/null || node -e \"fetch('https://registry.npmjs.org/').catch(e=>{console.error(String(e.cause||e));process.exit(3)})\"" } },
  { tool: "edit_file", arguments: { path: "test.txt", old_string: "hello", new_string: "hello, world" } },
  { tool: "terminal", arguments: { command: "printf '\\nappended\\n' >> /workspace/test.txt && cat /workspace/test.txt" } },
];
let next = 0;
let finished = false;
const job = {
  runId, missionId: "mission_e2e", instruction: "", role: "executor",
  tenantId: "tenant-e2e", organizationId: "org-e2e", userId: "user-e2e", projectId: "project-e2e",
  workspace: path.join(workspaces, "tenant-e2e", runId), canonicalProjectRoot: "/durable/project",
  sandbox: {
    sandboxId, provider, fallback: "none", policyTemplate: "code-basic", retention: "ephemeral", credentials: [],
    resources: { cpus: 1, memoryMb: 1024, pidsLimit: 256, commandTimeoutS: 60, maxLifetimeS: 600 },
  },
};
let assigned = false;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    const send = (o, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const u = new URL(req.url, "http://x");
    const p = u.pathname.replace(/^\/api\/v1\/worker/, "");
    if (p === "/register" || p === "/heartbeat") return send({ ok: true });
    if (p === "/poll") { if (!assigned) { assigned = true; return send({ job }); } return send({ job: null }); }
    if (p === `/workspace/${runId}/files`) return send({ canonical: true, files: Object.entries(canonical).map(([k, v]) => ({ path: k, contentBase64: Buffer.from(v).toString("base64") })) });
    if (p === `/workspace/${runId}/sync`) { synced = json.files; return send({ ok: true, written: json.files.map((f) => f.path) }); }
    if (p === `/tools/${runId}/next`) {
      if (finished) return send({ request: null, finished: true });
      const waiting = next > 0 && !results.has(next - 1);
      if (waiting || next >= script.length) {
        if (next >= script.length && results.size === script.length) finished = true;
        return send({ request: null, finished: false });
      }
      const s = script[next];
      return send({ request: { requestId: String(next++), runId, tool: s.tool, arguments: s.arguments, timeoutMs: 60_000, createdAt: Date.now() }, finished: false });
    }
    if (p === `/tools/${runId}/result`) { results.set(Number(json.requestId), json); return send({ ok: true }); }
    if (p === `/events/${runId}`) { events.push(json.type); return send({ ok: true }); }
    if (p === `/sandboxes/${runId}/report`) { reports.push(json); return send({ ok: true }); }
    if (p === "/sandboxes/live") return send({ live: [sandboxId] });
    if (p === "/sandboxes/reconciled") return send({ ok: true });
    if (p.startsWith("/cancel/")) return send({ cancelled: false });
    send({ error: "not found" }, 404);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const worker = spawn(process.execPath, [path.resolve("apps/worker/dist/index.js")], {
  env: {
    ...process.env,
    ORVYN_CONTROL_PLANE: `http://127.0.0.1:${port}`, ORVYN_API_KEY: "e2e", ORVYN_WORKSPACE_DIR: workspaces,
    OPENSHELL_ENABLED: provider === "openshell" ? "true" : "false",
    ORVYN_SANDBOX_POLICY_DIR: path.resolve("apps/worker/sandbox-policies"),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
worker.stdout.on("data", (d) => (log += d));
worker.stderr.on("data", (d) => (log += d));

const deadline = Date.now() + 180_000;
while (!log.includes("executeJob DONE") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
worker.kill("SIGTERM");
server.close();

const checks = [];
const check = (name, ok, detail = "") => { checks.push({ name, ok }); console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`); };
const r = (i) => results.get(i) ?? {};
console.log(`worker e2e with the ${provider} sandbox`);
check("mission finished and the worker survived", log.includes("executeJob DONE"));
check('"Create test.txt containing hello" written through the tool channel', r(0).ok === true && r(1).output === "hello");
check("terminal runs inside the sandbox on the same bytes", r(2).ok === true && /^hello\n\d+/.test(String(r(2).output)), JSON.stringify(r(2).output));
check(provider === "openshell" ? "sandbox user is not root" : "(docker runs as container root without capabilities)", provider !== "openshell" || !/\n0\s*$/.test(String(r(2).output)));
check("real exit code comes back", r(3).exitCode === 5 && r(3).ok === false);
const denied = String(r(4).stderr ?? "") + String(r(4).output ?? "");
check("network is closed; the model is told it is policy, not a bug", r(4).ok === false && (provider === "docker" || /NETWORK_POLICY_DENIED/.test(denied)), provider === "openshell" ? (denied.match(/NETWORK_POLICY_DENIED[^\n]*/)?.[0] ?? denied.slice(0, 120)) : "docker: --network none");
check("worker-side edit and sandbox-side append both land (file ownership handed to the sandbox user)", r(5).ok === true && r(6).ok === true && /hello, world\nappended/.test(String(r(6).output)), JSON.stringify(r(6).stderr ?? ""));
const syncedTest = (synced ?? []).find((f) => f.path === "test.txt");
check("changed files synced back to the durable workspace before removal", Boolean(syncedTest) && Buffer.from(syncedTest.contentBase64, "base64").toString() === "hello, world\nappended\n");
check("lifecycle events emitted without naming the runtime", ["sandbox.created", "sandbox.ready", "sandbox.destroyed"].every((t) => events.includes(t)) && !JSON.stringify(events).toLowerCase().includes("openshell"), events.filter((e) => e.startsWith("sandbox.")).join(", "));
check("registry reports ready then completed", reports.some((x) => x.state === "ready") && reports.some((x) => x.state === "completed"));
check("ephemeral workspace removed from the worker host", !fs.existsSync(job.workspace));
const left = provider === "docker"
  ? String(spawnSync("docker", ["ps", "-a", "--filter", "label=orvyn.sandbox=1", "--filter", `label=orvyn.sandbox_id=${sandboxId}`, "-q"]).stdout).trim()
  : String(spawnSync("docker", ["volume", "ls", "-q", "--filter", `name=orvyn-ws-${sandboxId.replace(/^sbx_/, "")}`]).stdout).trim();
check("sandbox destroyed", !left);
const failed = checks.filter((c) => !c.ok).length;
if (failed) console.log("\n--- worker log ---\n" + log.split("\n").slice(-40).join("\n"));
console.log(`\n${checks.length - failed}/${checks.length} passed`);
fs.rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
