import test from "node:test";
import assert from "node:assert/strict";
import { StreamingAgentRuntime } from "./StreamingAgentRuntime";
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(persist: () => void | Promise<void>) {
  const runtime: any = Object.create(StreamingAgentRuntime.prototype);
  const answers: boolean[] = [], approvedTools = new Set<string>();
  runtime.pending = new Map([["call", { runId: "run", call: { name: "fixture" }, destructive: false, resolve: (value: boolean) => answers.push(value) }]]);
  runtime.resolvingApprovals = new Set(); runtime.approvalInputs = new Map();
  runtime.runs = new Map([["run", { approvedTools, onApprovalGrant: persist }]]);
  return { runtime: runtime as StreamingAgentRuntime, state: runtime, answers, approvedTools };
}

test("remembered approvals wait for storage and duplicate requests do not execute twice", async () => {
  const gate = deferred(); let writes = 0;
  const h = fixture(async () => { writes++; await gate.promise; });
  const pending = h.runtime.resolveApproval("call", true, "project");
  assert.deepEqual(h.answers, []); assert.equal(h.approvedTools.size, 0);
  assert.equal(await h.runtime.resolveApproval("call", true, "project"), false);
  gate.resolve(); assert.equal(await pending, true);
  assert.equal(writes, 1); assert.deepEqual(h.answers, [true]); assert.ok(h.approvedTools.has("fixture"));
  assert.equal(await h.runtime.resolveApproval("call", true, "project"), false);
});

test("failed approval persistence leaves the call pending and accepts a later retry", async () => {
  let fail = true;
  const h = fixture(async () => { if (fail) throw new Error("database offline"); });
  await assert.rejects(h.runtime.resolveApproval("call", true, "always", { secrets: { token: "synthetic" } }), /database offline/);
  assert.deepEqual(h.answers, []); assert.equal(h.approvedTools.size, 0); assert.equal(h.state.approvalInputs.size, 0);
  fail = false; assert.equal(await h.runtime.resolveApproval("call", true, "always"), true);
  assert.deepEqual(h.answers, [true]);
});

test("a cancelled approval cannot execute when its delayed storage write finishes", async () => {
  const gate = deferred(), h = fixture(() => gate.promise);
  const pending = h.runtime.resolveApproval("call", true, "session");
  h.state.pending.delete("call"); gate.resolve();
  assert.equal(await pending, false); assert.deepEqual(h.answers, []); assert.equal(h.approvedTools.size, 0);
});

test("once-only and destructive approvals do not create remembered grants", async () => {
  let writes = 0;
  const once = fixture(() => { writes++; });
  assert.equal(await once.runtime.resolveApproval("call", true, "once"), true);
  assert.equal(once.approvedTools.size, 0);
  const destructive = fixture(() => { writes++; }); destructive.state.pending.get("call").destructive = true;
  assert.equal(await destructive.runtime.resolveApproval("call", true, "always"), true);
  assert.equal(destructive.approvedTools.size, 0); assert.equal(writes, 0);
});


test("tool permission changes wait for override writes and preserve cached permission on failure", async () => {
  const { persistToolPermission } = await import("../gateway/toolPermissionPersistence");
  const gate = deferred(); let permission = "ask", fail = true, revocations = 0;
  const tenant = {
    id: "fixture", currentProjectRoot: "/fixture",
    localStore: {
      clearToolApprovalGrants: async () => { revocations++; },
      setToolOverride: async () => { await gate.promise; if (fail) throw new Error("database offline"); },
    },
    toolRegistry: { setPermission: (_name: string, value: string) => { permission = value; } },
  };
  const pending = persistToolPermission(tenant, "subject", "fixture", "allowed");
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(permission, "ask");
  gate.resolve(); await assert.rejects(pending, /database offline/); assert.equal(permission, "ask");
  fail = false; await persistToolPermission(tenant, "subject", "fixture", "allowed");
  assert.equal(permission, "allowed"); assert.equal(revocations, 2);
});

test("project tool hydration failures preserve the existing registry", async () => {
  const { registerProjectToolsFor } = await import("../ai/registerProjectTools");
  let cleared = false;
  const tenant = {
    currentProjectRoot: null,
    toolGateway: { registry: { clear: () => { cleared = true; } } },
    localStore: { getToolOverrides: async () => { throw new Error("database offline"); } },
  };
  await assert.rejects(registerProjectToolsFor(tenant as any, "/fixture"), /database offline/);
  assert.equal(cleared, false); assert.equal(tenant.currentProjectRoot, null);
});
