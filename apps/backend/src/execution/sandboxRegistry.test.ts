// Execution sandbox control plane: registry identity rules, provider
// selection and canary gating, network-access requests (people decide,
// never the model), credential brokering scope, failure classification and
// worker-loss handling of tool calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SandboxRegistry } from "./sandbox/SandboxRegistry";
import { openShellEligible, resourcesForPlan, retentionFor, sandboxIdFor, selectSandbox, templatesForPlan, OPENSHELL_FLAG } from "./sandbox/selection";
import { credentialAllowed, decideRequest, pendingPolicyUpdate, publicHost, requestNetworkAccess } from "./sandbox/policyRequests";
import { classifyExecutedToolFailure } from "../agent/toolFailure";
import { classifyModelFailure } from "../models/modelAvailability";
import { ToolRpcChannel } from "./ToolRpc";

function freshRegistry(): SandboxRegistry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orvyn-sbx-reg-"));
  return new SandboxRegistry(path.join(dir, "execution.sqlite"));
}

const base = { organizationId: "org-a", tenantId: "t-a", userId: "u-a", projectId: "p-a", workspaceId: "p-a", runId: "run-a", policyTemplate: "code-basic", retention: "ephemeral" as const };

test("registry: identity is immutable; a report cannot move a sandbox to another organization", () => {
  const reg = freshRegistry();
  reg.plan({ ...base, id: "sbx_one", provider: "openshell" });
  assert.equal(reg.report("sbx_one", { organizationId: "org-b" }), null);
  assert.equal(reg.report("sbx_one", { tenantId: "t-b" }), null);
  assert.equal(reg.report("sbx_one", { provider: "docker" }), null, "provider changes only through recordFallback");
  const ok = reg.report("sbx_one", { state: "ready", providerSandboxId: "prov-1", provisionMs: 812 });
  assert.equal(ok?.state, "ready");
  assert.ok(ok?.readyAt);
  assert.equal(ok?.organizationId, "org-a");
  reg.recordFallback("sbx_one", "docker", "gateway down");
  assert.equal(reg.get("sbx_one")?.provider, "docker");
  assert.equal(reg.get("sbx_one")?.fallbackReason, "gateway down");
  assert.throws(() => reg.plan({ ...base, id: "sbx_one", provider: "docker", organizationId: "org-b" }), /immutable/);
});

test("registry: stats per provider for admin health", () => {
  const reg = freshRegistry();
  reg.plan({ ...base, id: "sbx_a", provider: "openshell" });
  reg.plan({ ...base, id: "sbx_b", provider: "openshell", runId: "run-b" });
  reg.report("sbx_a", { state: "ready", provisionMs: 800 });
  reg.report("sbx_b", { state: "failed", lastError: "boom" });
  reg.bump("sbx_a", "policyDenials");
  reg.bump("sbx_a", "reconnects");
  reg.addExec("sbx_a", 25);
  const s = reg.stats(3600_000).byProvider.openshell!;
  assert.equal(s.active, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.avgProvisionMs, 800);
  assert.equal(s.policyDenials, 1);
  assert.equal(s.reconnects, 1);
  assert.equal(s.execCount, 1);
});

test("selection: Docker unless the deployment enables OpenShell AND the org is in the canary", () => {
  const reg = freshRegistry();
  const input = { organizationId: "org-a", tenantId: "t-a", projectId: "p-a", planId: "pro", runId: "r", workspaceId: "p-a" };
  assert.equal(selectSandbox(input, reg, {}).provider, "docker");
  assert.equal(selectSandbox(input, reg, { ORVYN_EXECUTION_PROVIDER: "auto" }).provider, "docker", "not enabled");
  const on = { ORVYN_EXECUTION_PROVIDER: "auto", OPENSHELL_ENABLED: "true", OPENSHELL_ACCEPTANCE_PASSED: "true" };
  assert.equal(selectSandbox(input, reg, on).provider, "docker", "enabled but not in canary");
  reg.setFlag("org", "org-a", OPENSHELL_FLAG, true, "staff:x");
  assert.equal(selectSandbox(input, reg, { ...on, OPENSHELL_ACCEPTANCE_PASSED: "false" }).provider, "docker", "a flagged org stays on Docker until this deploy's acceptance passed");
  const plan = selectSandbox(input, reg, on);
  assert.equal(plan.provider, "openshell");
  assert.equal(plan.fallback, "docker", "auto falls back");
  assert.equal(plan.policyTemplate, "code-basic", "every mission starts deny-all");
  assert.equal(selectSandbox(input, reg, { ...on, ORVYN_EXECUTION_PROVIDER: "openshell" }).fallback, "none");
  assert.equal(selectSandbox(input, reg, { ...on, ORVYN_EXECUTION_PROVIDER: "docker" }).provider, "docker", "global docker wins");
  reg.setFlag("project", "p-a", OPENSHELL_FLAG, false, "staff:x");
  assert.equal(selectSandbox(input, reg, on).provider, "docker", "an explicit off wins");
});

test("selection: canary list and percentage (percentage only after acceptance)", () => {
  const reg = freshRegistry();
  const input = { organizationId: "org-z", projectId: null };
  const on = { ORVYN_EXECUTION_PROVIDER: "auto", OPENSHELL_ENABLED: "true" };
  assert.equal(openShellEligible(input, reg, { ...on, OPENSHELL_CANARY_ORGS: "org-y, org-z" }).eligible, false, "not even the canary list before acceptance");
  assert.equal(openShellEligible(input, reg, { ...on, OPENSHELL_CANARY_ORGS: "org-y, org-z", OPENSHELL_ACCEPTANCE_PASSED: "true" }).eligible, true);
  assert.equal(openShellEligible(input, reg, { ...on, OPENSHELL_CANARY_PERCENT: "100" }).eligible, false, "no global activation before acceptance");
  assert.equal(openShellEligible(input, reg, { ...on, OPENSHELL_CANARY_PERCENT: "100", OPENSHELL_ACCEPTANCE_PASSED: "true" }).eligible, true);
});

test("plan tiers: limits never below the old container, templates widen with the plan", () => {
  for (const plan of ["free", "starter", "pro", "power", "business", "team", "enterprise", null]) {
    const r = resourcesForPlan(plan);
    assert.ok(r.cpus >= 1 && r.memoryMb >= 1024 && r.pidsLimit >= 256, String(plan));
  }
  assert.ok(!templatesForPlan("free").includes("github"));
  assert.ok(templatesForPlan("business").includes("server-admin"));
  assert.ok(!templatesForPlan("pro").includes("server-admin"));
  assert.equal(retentionFor("pro", "p", "openshell", {}), "ephemeral", "retention is opt-in");
  assert.equal(retentionFor("pro", "p", "openshell", { ORVYN_SANDBOX_RETAIN: "true" }), "retained");
  assert.equal(retentionFor("free", "p", "openshell", { ORVYN_SANDBOX_RETAIN: "true" }), "ephemeral");
  assert.equal(retentionFor("pro", "p", "docker", { ORVYN_SANDBOX_RETAIN: "true" }), "ephemeral");
  assert.equal(sandboxIdFor({ organizationId: "o", projectId: "p" }, "retained"), sandboxIdFor({ organizationId: "o", projectId: "p" }, "retained"));
  assert.notEqual(sandboxIdFor({ organizationId: "o", projectId: "p" }, "ephemeral"), sandboxIdFor({ organizationId: "o", projectId: "p" }, "ephemeral"));
});

test("network requests: the model asks, a person decides, credentials follow only the approval", () => {
  const reg = freshRegistry();
  reg.plan({ ...base, id: "sbx_d", provider: "docker", runId: "run-d" });
  assert.equal((requestNetworkAccess(reg, { runId: "run-d", template: "web-development", planId: "pro" }) as any).code, "NOT_SUPPORTED");
  assert.equal((requestNetworkAccess(reg, { runId: "nope", template: "web-development", planId: "pro" }) as any).code, "NO_SANDBOX");

  reg.plan({ ...base, id: "sbx_o", provider: "openshell", runId: "run-o" });
  assert.equal((requestNetworkAccess(reg, { runId: "run-o", template: "github", planId: "free" }) as any).code, "NOT_ON_PLAN");
  assert.equal((requestNetworkAccess(reg, { runId: "run-o", template: "server-admin", hosts: ["10.0.0.5"], planId: "business" }) as any).code, "BAD_REQUEST");
  assert.equal((requestNetworkAccess(reg, { runId: "run-o", template: "code-basic", planId: "pro" }) as any).code, "BAD_REQUEST");

  const out = requestNetworkAccess(reg, { runId: "run-o", template: "github", reason: "clone the repo", planId: "pro" });
  assert.ok(out.ok);
  const id = (out as any).request.id as string;
  assert.equal(requestNetworkAccess(reg, { runId: "run-o", template: "github", planId: "pro" }).ok && (requestNetworkAccess(reg, { runId: "run-o", template: "github", planId: "pro" }) as any).request.id, id, "duplicate pending requests collapse");
  assert.equal(pendingPolicyUpdate(reg, "run-o"), null, "nothing reaches the worker before approval");
  assert.equal(credentialAllowed(reg, "run-o", "github").ok, false, "no credential before approval");

  assert.throws(() => reg.decidePolicy(id, true, "model:run-o"), /person/);
  assert.equal(decideRequest(reg, id, true, "user:u-b", { organizationId: "org-b" }), null, "another org cannot decide");
  const approved = decideRequest(reg, id, true, "user:u-a", { organizationId: "org-a" });
  assert.equal(approved?.status, "approved");

  const upd = pendingPolicyUpdate(reg, "run-o")!;
  assert.equal(upd.template, "github");
  assert.deepEqual(upd.credentials, [{ integrationId: "github", type: "orvyn-github", organizationId: "org-a" }]);
  assert.equal(credentialAllowed(reg, "run-o", "github").ok, true);
  assert.equal(credentialAllowed(reg, "run-o", "slack").ok, false, "only the integration the template needs");
  assert.equal(credentialAllowed(reg, "run-d", "github").ok, false, "never for a docker sandbox");
  reg.markPolicyApplied(id, true);
  assert.equal(reg.policyRequest(id)?.status, "applied");
  assert.equal(pendingPolicyUpdate(reg, "run-o"), null);

  reg.report("sbx_o", { state: "completed" });
  assert.equal(credentialAllowed(reg, "run-o", "github").ok, false, "no credential after the sandbox is gone");
  const types = reg.auditLog({ organizationId: "org-a" }).map((a) => a.type);
  assert.ok(types.includes("policy.expansion.requested") && types.includes("policy.expansion.approved"));
});

test("public host check refuses internal and metadata addresses", () => {
  for (const h of ["localhost", "127.0.0.1", "10.2.3.4", "169.254.169.254", "192.168.0.10", "172.16.0.1", "100.64.0.1", "db.internal", "printer.local"]) assert.equal(publicHost(h), false, h);
  for (const h of ["deploy.example.com", "203.0.113.10"]) assert.equal(publicHost(h), true, h);
});

test("policy denials are permission failures, never a reason to switch models", () => {
  const msg = "Remote tool failed (exit 7)\n--- output ---\nNETWORK_POLICY_DENIED: this workspace's network policy blocked the connection.\ncurl: (7) Failed to connect to registry.npmjs.org port 443 after 3 ms: Couldn't connect to server";
  assert.equal(classifyExecutedToolFailure(msg), "PERMISSION_DENIED");
  assert.equal(classifyExecutedToolFailure("CREDENTIAL_POLICY_DENIED: no credential"), "PERMISSION_DENIED");
  assert.equal(classifyExecutedToolFailure("SANDBOX_UNAVAILABLE: Sandbox is gone."), "CAPABILITY_UNAVAILABLE");
  // Tool results never pass through the model-failure classifier; even if one did, a denial is not a provider outage.
  assert.equal(classifyModelFailure(new Error("NETWORK_POLICY_DENIED: this workspace's network policy blocked the connection.")), null);
});

test("worker loss: in-flight tool calls fail truthfully, queued ones wait for the recovering worker", async () => {
  const rpc = new ToolRpcChannel();
  const first = rpc.execute("run-x", "terminal", { command: "npm test" }, 60_000);
  const second = rpc.execute("run-x", "read_file", { path: "a.txt" }, 60_000);
  assert.equal(rpc.poll("run-x")?.tool, "terminal"); // taken by the worker that then dies
  assert.equal(rpc.failInFlight("run-x", "worker restarted"), 1);
  const r1 = await first;
  assert.equal(r1.ok, false);
  assert.match(String(r1.error), /restarted/);
  const next = rpc.poll("run-x");
  assert.equal(next?.tool, "read_file", "queued request survives for the next worker");
  rpc.resolve({ requestId: next!.requestId, runId: "run-x", ok: true, output: "x", durationMs: 1 });
  assert.equal((await second).ok, true);
});
