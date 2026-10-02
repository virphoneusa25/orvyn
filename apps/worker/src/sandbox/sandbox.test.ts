// Worker execution-sandbox tests: policy templates, plan validation, failure
// classification, provider selection/fallback/reconnect/reconcile against
// fakes, and — when a Docker daemon and a local image are available — the real
// Docker provider (exit codes, timeouts, no network, tenant-scoped lookup).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import { loadTemplates, renderPolicy, validatePublicHost, validateTemplate, allowedHosts } from "./policies";
import { normalizePlan, legacyPlan, SandboxRuntime } from "./runtime";
import { classifyExecOutput, openShellWorkspaceFor, openShellSandboxName, stateFromPhase } from "./openshell";
import { DockerExecutionProvider } from "./docker";
import { SandboxError, type ExecutionSandboxProvider, type SandboxHandle, type CreateSandboxSpec, type SandboxIdentity } from "./types";

process.env.ORVYN_SANDBOX_POLICY_DIR = path.resolve(__dirname, "..", "..", "sandbox-policies");

test("every policy template loads, validates, and code-basic has no network", () => {
  const all = loadTemplates();
  assert.equal(all.size, 6);
  for (const t of all.values()) validateTemplate(t);
  assert.deepEqual(Object.keys(renderPolicy("code-basic").policy.network_policies ?? {}), []);
  const web = renderPolicy("web-development").policy;
  assert.ok(allowedHosts(web).includes("registry.npmjs.org:443"));
  assert.ok(!allowedHosts(web).some((h) => h.startsWith("github.com")), "web-development does not reach GitHub");
  for (const t of all.values()) {
    assert.notEqual(t.policy.process.run_as_user, "root");
    assert.deepEqual([...t.policy.filesystem.read_write].sort(), ["/dev/null", "/tmp", "/workspace"]);
  }
});

test("template validation refuses widening", () => {
  const base = JSON.parse(JSON.stringify(loadTemplates().get("research")));
  const bad = (mut: (p: any) => void) => { const t = JSON.parse(JSON.stringify(base)); mut(t.policy); return () => validateTemplate(t); };
  assert.throws(bad((p) => { p.process.run_as_user = "root"; }));
  assert.throws(bad((p) => { p.filesystem.read_write.push("/etc"); }));
  assert.throws(bad((p) => { p.network_policies.reference_docs.endpoints[0].host = "*.org"; }));
  assert.throws(bad((p) => { p.network_policies.reference_docs.endpoints[0].enforcement = "NETWORK_ENFORCEMENT_MODE_AUDIT"; }));
  assert.throws(bad((p) => { p.network_policies.reference_docs.endpoints[0].allowed_ips = ["10.0.0.0/8"]; }));
  assert.throws(bad((p) => { p.network_policies.reference_docs.binaries = []; }));
});

test("server-admin renders only approved public hosts", () => {
  assert.deepEqual(renderPolicy("server-admin").policy.network_policies, {}, "no host → no rule (deny)");
  const r = renderPolicy("server-admin", { host: ["deploy.example.com"] }).policy;
  assert.deepEqual(allowedHosts(r), ["deploy.example.com:22"]);
  const research = renderPolicy("research", { host: ["virphoneusa.com"] }).policy;
  assert.ok(allowedHosts(research).includes("developer.mozilla.org:443"));
  assert.ok(allowedHosts(research).includes("virphoneusa.com:443"));
  assert.ok(!allowedHosts(renderPolicy("research").policy).includes("virphoneusa.com:443"));
  for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.5", "172.20.0.1", "db.internal", "x"]) {
    assert.equal(validatePublicHost(h), false, h);
    assert.throws(() => renderPolicy("server-admin", { host: [h] }), SandboxError);
  }
  assert.equal(validatePublicHost("203.0.113.9"), true);
});

test("a malformed plan becomes the safe default, never wider", () => {
  const p = normalizePlan({ sandboxId: "../../etc", provider: "kubernetes", policyTemplate: "anything", resources: { cpus: 999, memoryMb: -1, pidsLimit: "x" }, retention: "forever", credentials: [{ integrationId: 1 }] }, "run-1234567890", 3600);
  assert.equal(p.provider, "docker");
  assert.equal(p.policyTemplate, "code-basic");
  assert.equal(p.resources.cpus, 16);
  assert.equal(p.resources.memoryMb, 256);
  assert.equal(p.resources.pidsLimit, 256);
  assert.equal(p.retention, "ephemeral");
  assert.deepEqual(p.credentials, []);
  assert.match(p.sandboxId, /^sbx_/);
  assert.deepEqual(normalizePlan(undefined, "r1abcdefgh", 60), legacyPlan("r1abcdefgh", 60));
});

test("OpenShell denials are classified; ordinary failures are not", () => {
  assert.equal(classifyExecOutput({ exitCode: 56, stdout: "", stderr: "curl: (56) CONNECT tunnel failed, response 403" }), "network_policy_denied");
  assert.equal(classifyExecOutput({ exitCode: 22, stdout: '{"error":"policy_denied","policy":"x"}', stderr: "" }), "network_policy_denied");
  assert.equal(classifyExecOutput({ exitCode: 3, stdout: "", stderr: "Error: connect EACCES 198.18.0.2:443 - Local (0.0.0.0:0)" }), "network_policy_denied");
  assert.equal(classifyExecOutput({ exitCode: 7, stdout: "", stderr: "curl: (7) Failed to connect to registry.npmjs.org port 443 after 4 ms: Couldn't connect to server" }), "network_policy_denied");
  assert.equal(classifyExecOutput({ exitCode: 1, stdout: "", stderr: "npm ERR! Test failed" }), null);
  assert.equal(classifyExecOutput({ exitCode: 1, stdout: "", stderr: "cat: /etc/shadow: Permission denied" }), null);
  assert.equal(classifyExecOutput({ exitCode: 0, stdout: "policy_denied", stderr: "" }), null);
  assert.equal(stateFromPhase("provisioning"), "provisioning");
  assert.equal(stateFromPhase("error"), "failed");
  assert.equal(stateFromPhase("weird"), "degraded");
});

test("OpenShell names are deterministic, DNS-safe, and never reveal the organization id", () => {
  const ws = openShellWorkspaceFor("org_ACME_secret");
  assert.match(ws, /^orv-[0-9a-f]{15}$/);
  assert.ok(ws.length <= 19);
  assert.ok(!ws.includes("acme"));
  assert.equal(ws, openShellWorkspaceFor("org_ACME_secret"));
  assert.notEqual(ws, openShellWorkspaceFor("org_other"));
  assert.match(openShellSandboxName("sbx_ABCdef123"), /^s-[0-9a-f]{17}$/);
  assert.equal(openShellSandboxName("sbx_ABCdef123").length, 19);
});

// ── fakes ─────────────────────────────────────────────────────────────
class FakeProvider implements ExecutionSandboxProvider {
  created: CreateSandboxSpec[] = [];
  destroyed: string[] = [];
  live = new Map<string, SandboxHandle>();
  failCreate: SandboxError | null = null;
  execOut = { exitCode: 0, stdout: "ok", stderr: "" };
  listRows: any[] = [];
  constructor(readonly id: "docker" | "openshell") {}
  getCapabilities() { return { filesystem: true, terminal: true, attach: false, network: "none" as const, networkPolicyTemplates: [], liveNetworkPolicyUpdate: false, credentialBroker: false, reconnect: true, retainedSandboxes: true, browser: false, gpu: false }; }
  async getHealth() { return { provider: this.id, healthy: true, checkedAt: Date.now() }; }
  async createSandbox(spec: CreateSandboxSpec): Promise<SandboxHandle> {
    if (this.failCreate) throw this.failCreate;
    this.created.push(spec);
    const h: SandboxHandle = { sandboxId: spec.sandboxId, provider: this.id, providerSandboxId: "p-" + spec.sandboxId, name: spec.sandboxId, identity: spec.identity, state: "ready", createdAt: Date.now(), policyTemplate: spec.policyTemplate, policyVersion: 1, retention: spec.retention, provisionMs: 42 };
    this.live.set(spec.sandboxId, h);
    return h;
  }
  async getSandbox(id: string, identity: SandboxIdentity) {
    const h = this.live.get(id);
    return h && h.identity.organizationId === identity.organizationId ? h : null;
  }
  async exec() { return { ...this.execOut, startedAt: 1, completedAt: 2, timedOut: false }; }
  async attach(): Promise<any> { throw new Error("n/a"); }
  async stop() {}
  async destroy(h: SandboxHandle) { this.destroyed.push(h.sandboxId); this.live.delete(h.sandboxId); }
  async list() { return this.listRows; }
}

function events() {
  const emitted: Array<[string, Record<string, unknown>]> = [];
  const reports: Array<Record<string, unknown>> = [];
  return { emitted, reports, sink: { emit: async (_r: string, t: string, d: Record<string, unknown>) => { emitted.push([t, d]); }, report: async (_r: string, b: Record<string, unknown>) => { reports.push(b); } } };
}

const ident: SandboxIdentity = { organizationId: "org-a", tenantId: "t-a", userId: "u-a", projectId: "p-a", workspaceId: "w-a", runId: "run-a" };

test("openshell unavailable: auto falls back to docker and says so; strict mode fails", async () => {
  const docker = new FakeProvider("docker");
  const os1 = new FakeProvider("openshell");
  os1.failCreate = new SandboxError("sandbox_unavailable", "gateway down");
  const ev = events();
  const rt = new SandboxRuntime(ev.sink, { docker, openshell: os1 });
  const plan = { ...legacyPlan("run-a", 600), provider: "openshell" as const, fallback: "docker" as const };
  const h = await rt.acquire("run-a", plan, ident, "/tmp/ws");
  assert.equal(h.provider, "docker");
  assert.ok(ev.reports.some((r) => r.fallbackTo === "docker" && String(r.fallbackReason).includes("gateway down")));
  assert.ok(!JSON.stringify(ev.emitted).toLowerCase().includes("openshell"), "customer events never name the runtime");

  const rt2 = new SandboxRuntime(events().sink, { docker: new FakeProvider("docker"), openshell: os1 });
  await assert.rejects(rt2.acquire("run-b", { ...plan, fallback: "none" }, ident, "/tmp/ws"), /gateway down/);
  const rt3 = new SandboxRuntime(events().sink, { docker: new FakeProvider("docker"), openshell: null });
  await assert.rejects(rt3.acquire("run-c", { ...plan, fallback: "none" }, ident, "/tmp/ws"), /not enabled/);
});

test("reconnects to a live sandbox instead of creating a second one", async () => {
  const docker = new FakeProvider("docker");
  const ev = events();
  const rt = new SandboxRuntime(ev.sink, { docker, openshell: null });
  const plan = legacyPlan("run-r", 600);
  await rt.acquire("run-r", plan, ident, "/tmp/ws");
  const rt2 = new SandboxRuntime(ev.sink, { docker, openshell: null }); // a restarted worker
  const h2 = await rt2.acquire("run-r", plan, ident, "/tmp/ws");
  assert.equal(docker.created.length, 1);
  assert.equal(h2.sandboxId, plan.sandboxId);
  assert.ok(ev.emitted.some(([t]) => t === "sandbox.reconnected"));
  // Another organization never gets this sandbox back.
  const other = await docker.getSandbox(plan.sandboxId, { ...ident, organizationId: "org-b" });
  assert.equal(other, null);
});

test("policy denials are classified, counted and reported; retained sandboxes survive release", async () => {
  const os1 = new FakeProvider("openshell");
  os1.execOut = { exitCode: 56, stdout: "", stderr: "curl: (56) CONNECT tunnel failed, response 403" };
  const ev = events();
  const rt = new SandboxRuntime(ev.sink, { docker: new FakeProvider("docker"), openshell: os1 });
  await rt.acquire("run-d", { ...legacyPlan("run-d", 600), provider: "openshell", retention: "retained" }, ident, "/tmp/ws");
  const r = await rt.exec("run-d", "curl https://example.com");
  assert.equal(r.failureKind, "network_policy_denied");
  assert.ok(ev.emitted.some(([t]) => t === "sandbox.policy.denied"));
  assert.equal((rt.stats().openshell as any).policyDenials, 1);
  await rt.release("run-d", "run finished");
  assert.equal(os1.destroyed.length, 0, "retained sandbox kept for the next run");
  await rt.acquire("run-d", { ...legacyPlan("run-d", 600), provider: "openshell", retention: "retained" }, ident, "/tmp/ws");
  await rt.release("run-d", "run cancelled", { force: true });
  assert.equal(os1.destroyed.length, 1, "a cancelled run destroys even a retained sandbox");
});

test("reconcile removes orphans and expired sandboxes, keeps live, young and retained ones", async () => {
  const docker = new FakeProvider("docker");
  const now = Date.now();
  const row = (id: string, ageMs: number, labels: Record<string, string> = {}) => ({ sandboxId: id, name: id, providerSandboxId: id, state: "ready", createdAt: now - ageMs, labels });
  docker.listRows = [
    row("sbx_orphan", 600_000),
    row("sbx_live", 600_000),
    row("sbx_young", 10_000),
    row("sbx_retained", 600_000, { "orvyn.retention": "retained", "orvyn.expires_at": String(now + 60_000) }),
    row("sbx_expired", 600_000, { "orvyn.retention": "retained", "orvyn.expires_at": String(now - 1) }),
  ];
  const rt = new SandboxRuntime(events().sink, { docker, openshell: null });
  const out = await rt.reconcile(new Set(["sbx_live"]), now);
  assert.deepEqual(out.removed.sort(), ["sbx_expired", "sbx_orphan"]);
  assert.equal(out.kept, 3);
});

// ── real Docker (skipped when no daemon or image) ─────────────────────
const IMAGE = process.env.ORVYN_TEST_SANDBOX_IMAGE || "orvyn-base:noble";
const dockerOk = spawnSync("docker", ["image", "inspect", IMAGE], { stdio: "ignore" }).status === 0;

test("docker provider: real exit codes, timeouts, no network, workspace mount, tenant-scoped lookup", { skip: !dockerOk && `no docker image ${IMAGE}` }, async () => {
  const p = new DockerExecutionProvider(IMAGE);
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-sbx-"));
  const spec: CreateSandboxSpec = {
    sandboxId: `sbx_test${Date.now().toString(36)}`, identity: ident, workspaceHostPath: ws,
    resources: { cpus: 1, memoryMb: 512, pidsLimit: 128, commandTimeoutS: 30, maxLifetimeS: 300 },
    policyTemplate: "web-development", retention: "ephemeral",
  };
  const h = await p.createSandbox(spec);
  try {
    assert.equal(h.policyTemplate, "code-basic", "docker reports the policy it actually enforces");
    const w = await p.exec(h, "printf hello > /workspace/test.txt");
    assert.equal(w.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(ws, "test.txt"), "utf8"), "hello");
    assert.equal((await p.exec(h, "exit 3")).exitCode, 3);
    const t = await p.exec(h, "sleep 10", { timeoutS: 1 });
    assert.equal(t.timedOut, true);
    assert.equal(t.exitCode, 124);
    const net = await p.exec(h, "cat /sys/class/net/*/operstate 2>/dev/null | wc -l; ls /sys/class/net");
    assert.deepEqual(net.stdout.trim().split(/\s+/).filter((x) => x !== "1" && x !== "0").sort(), ["lo"], "only loopback exists");
    const caps = await p.exec(h, "grep CapEff /proc/self/status");
    assert.match(caps.stdout, /0000000000000000/);
    assert.equal(await p.getSandbox(spec.sandboxId, { ...ident, organizationId: "org-b" }), null);
    assert.ok(await p.getSandbox(spec.sandboxId, ident));
  } finally {
    await p.destroy(h);
    fs.rmSync(ws, { recursive: true, force: true });
  }
  assert.equal(await p.getSandbox(spec.sandboxId, ident), null);
});
