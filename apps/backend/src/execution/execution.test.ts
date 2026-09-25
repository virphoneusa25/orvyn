// Provider selection, local execution, Docker adapter truthfulness,
// OVH unavailability, cancellation, and failure isolation — all against
// the real provider implementations.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionRouter } from "./ExecutionRouter";
import { LocalExecutionProvider } from "./LocalExecutionProvider";
import { OvhWorkerProvider } from "./OvhWorkerProvider";
import { DockerExecutionProvider } from "./DockerExecutionProvider";

// ---- Provider selection ---------------------------------------------------

test("routing: simple task → LOCAL", async () => {
  const router = new ExecutionRouter();
  const decision = await router.select({ preference: "auto", isIsolated: false });
  assert.equal(decision.location, "LOCAL");
  assert.ok(decision.provider instanceof LocalExecutionProvider);
});

test("routing: explicit LOCAL always returns LOCAL", async () => {
  const router = new ExecutionRouter();
  const d = await router.select({ preference: "LOCAL" });
  assert.equal(d.location, "LOCAL");
});

test("routing: explicit DOCKER_LOCAL does not silently become LOCAL when Docker is down", async () => {
  const router = new ExecutionRouter();
  const dockerHealth = await router.docker.health();
  if (dockerHealth.healthy) {
    const d = await router.select({ preference: "DOCKER_LOCAL" });
    assert.equal(d.location, "DOCKER_LOCAL");
  } else {
    await assert.rejects(() => router.select({ preference: "DOCKER_LOCAL" }), /no silent Local fallback/i);
  }
});

test("routing: explicit OVH_WORKER does not silently become LOCAL", async () => {
  const router = new ExecutionRouter();
  await assert.rejects(() => router.select({ preference: "OVH_WORKER" }), /no silent Local fallback/i);
});

test("routing: Auto + remote-flagged task is honest when OVH is down", async () => {
  const router = new ExecutionRouter();
  const d = await router.select({ isRemote: true });
  assert.notEqual(d.location, "OVH_WORKER", "must not claim OVH");
  assert.ok(d.reason.includes("ORVYN Cloud unavailable"), `reason says the cloud is unavailable: ${d.reason}`);
});

// ---- Local provider --------------------------------------------------------

test("local: executeCommand runs a real command and returns output", async () => {
  const p = new LocalExecutionProvider();
  await p.startRun("r1", process.cwd());
  const res = await p.executeCommand("r1", process.platform === "win32" ? "echo hello" : "echo hello");
  assert.ok(res.ok);
  assert.match(res.output, /hello/);
  await p.stopRun("r1");
});

test("local: cancel prevents further commands", async () => {
  const p = new LocalExecutionProvider();
  await p.startRun("r2", process.cwd());
  await p.cancel("r2");
  const res = await p.executeCommand("r2", "echo should-not-run");
  assert.ok(!res.ok, "command must not run after cancel");
  await p.stopRun("r2");
});

test("local: health always healthy", async () => {
  const p = new LocalExecutionProvider();
  const h = await p.health();
  assert.ok(h.healthy);
});

// ---- Docker provider truthfulness ------------------------------------------

test("docker: health reports truthfully (no fake green)", async () => {
  const p = new DockerExecutionProvider();
  const h = await p.health();
  // Both outcomes valid — the contract is that health() checks the REAL daemon.
  if (!h.healthy) assert.ok(h.detail, "unhealthy must carry a detail reason");
  else assert.ok(h.detail === undefined);
});

test("docker: executeCommand without startRun returns error (no silent fallback)", async () => {
  const p = new DockerExecutionProvider();
  const res = await p.executeCommand("no-such-run", "echo hi");
  assert.ok(!res.ok);
  assert.match(res.output, /No sandbox/);
});

// ---- OVH provider ----------------------------------------------------------

test("ovh: health reports unavailable without a worker URL", async () => {
  const saved = process.env.ORVYN_OVH_WORKER_URL;
  delete process.env.ORVYN_OVH_WORKER_URL;
  try {
    const p = new OvhWorkerProvider();
    const h = await p.health();
    assert.ok(!h.healthy);
    assert.ok(h.detail?.includes("not configured") || h.detail?.includes("not deployed"), `truthful: ${h.detail}`);
  } finally {
    if (saved) process.env.ORVYN_OVH_WORKER_URL = saved;
  }
});

test("ovh: startRun rejects — never fakes remote execution", async () => {
  const saved = process.env.ORVYN_OVH_WORKER_URL;
  delete process.env.ORVYN_OVH_WORKER_URL;
  try {
    const p = new OvhWorkerProvider();
    await assert.rejects(() => p.startRun("r", "/tmp"), /not configured|not deployed/);
  } finally {
    if (saved) process.env.ORVYN_OVH_WORKER_URL = saved;
  }
});

// ---- Failure isolation -----------------------------------------------------

test("provider failure never throws into the caller (executeCommand returns error)", async () => {
  const p = new DockerExecutionProvider();
  // No sandbox started — must return an error result, NOT throw.
  const res = await p.executeCommand("bad-run", "anything");
  assert.ok(!res.ok);
});

test("router dispose is safe with no active runs", async () => {
  const router = new ExecutionRouter();
  await router.dispose(); // must not throw
});

// ---- Tool RPC request lifecycle ---------------------------------------------
// Pins the spec's safety properties: one resolve per requestId, duplicates
// and unknown ids rejected, timeouts remove the pending entry so late
// results can never resolve anything, and cancel/fail resolve truthfully.

import { ToolRpcChannel, ToolResponse } from "./ToolRpc";

function resultOf(requestId: string, ok = true, output = "done"): ToolResponse {
  return { requestId, runId: "run-x", ok, output, durationMs: 5 };
}

test("toolRpc: normal request resolves exactly once; duplicate result is ignored", async () => {
  const rpc = new ToolRpcChannel();
  const pending = rpc.execute("run-x", "read_file", { path: "a.js" }, 5_000);
  const req = rpc.poll("run-x");
  assert.ok(req, "request handed to the polling worker");
  assert.equal(rpc.resolve(resultOf(req.requestId)), true, "first result resolves");
  const first = await pending;
  assert.equal(first.ok, true);
  assert.equal(rpc.resolve(resultOf(req.requestId)), false, "duplicate result ignored");
});

test("toolRpc: unknown requestId is rejected", () => {
  const rpc = new ToolRpcChannel();
  assert.equal(rpc.resolve(resultOf("nope")), false);
});

test("toolRpc: timeout rejects the promise, removes the pending entry, and a late result cannot resolve it", async () => {
  const rpc = new ToolRpcChannel();
  const pending = rpc.execute("run-x", "terminal", { command: "sleep 999" }, 40);
  const req = rpc.poll("run-x");
  assert.ok(req);
  await assert.rejects(pending, /timed out/);
  // The worker finally answers after the timeout — it must be ignored.
  assert.equal(rpc.resolve(resultOf(req!.requestId)), false);
});

test("toolRpc: cancelRun resolves pending requests as cancelled; queue is dropped", async () => {
  const rpc = new ToolRpcChannel();
  const a = rpc.execute("run-x", "read_file", { path: "a" }, 5_000);
  rpc.execute("run-x", "read_file", { path: "b" }, 5_000); // still queued
  const first = rpc.poll("run-x");
  assert.ok(first);
  rpc.cancelRun("run-x");
  const r = await a;
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /Cancelled by user/);
  assert.equal(rpc.poll("run-x"), null, "queued request dropped by cancel");
});

test("toolRpc: failRun resolves pending requests with the truthful reason", async () => {
  const rpc = new ToolRpcChannel();
  const a = rpc.execute("run-x", "run_tests", {}, 5_000);
  rpc.poll("run-x");
  rpc.failRun("run-x", "worker stopped the mission container");
  const r = await a;
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /worker stopped/);
});

test("toolRpc: cleanup resolves pending as ended; a late result cannot resolve anything", async () => {
  const rpc = new ToolRpcChannel();
  const a = rpc.execute("run-x", "read_file", { path: "a" }, 5_000);
  const req = rpc.poll("run-x");
  rpc.cleanup("run-x");
  const r = await a;
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /run has ended/);
  assert.equal(rpc.resolve(resultOf(req!.requestId)), false, "late result after cleanup ignored");
});

// ---- Reasoning-effort adapter mapping ---------------------------------------
// The wire field is only sent when the model DECLARES reasoningControl and
// the requested level exists in its levels map — never pretended.

import { OpenAICompatibleAdapter } from "@orvyn/ai-core";

function reasoningAdapter(levels?: Record<string, string>) {
  const captured: any[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    captured.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as any;
  const adapter = new OpenAICompatibleAdapter({
    id: "reason-model",
    name: "Reason Model",
    provider: "openai-compatible",
    endpoint: "http://reason.test",
    contextWindow: 128000,
    maxOutputTokens: 4000,
    defaultTemperature: 0,
    defaultTopP: 1,
    streaming: false,
    capabilities: { chat: true, code: true, agent: true, tools: true, vision: false, embeddings: false, completion: false, image: false },
    ...(levels ? { reasoningControl: { param: "reasoning_effort", levels } } : {}),
  } as any);
  return { adapter, captured, restore: () => { globalThis.fetch = originalFetch; } };
}

test("reasoning: declared levels map onto the wire field", async () => {
  const { adapter, captured, restore } = reasoningAdapter({ fast: "low", standard: "medium", deep: "high" });
  try {
    await adapter.generate({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "deep" } as any);
    assert.equal(captured[0].reasoning_effort, "high");
  } finally { restore(); }
});

test("reasoning: auto never sends the field; undeclared levels are not sent", async () => {
  const { adapter, captured, restore } = reasoningAdapter({ fast: "low", standard: "medium", deep: "high" });
  try {
    await adapter.generate({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "auto" } as any);
    assert.equal(captured[0].reasoning_effort, undefined, "auto defers entirely");
    await adapter.generate({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "max" } as any);
    assert.equal(captured[1].reasoning_effort, undefined, "max not declared → not sent");
  } finally { restore(); }
});

test("reasoning: model without reasoningControl never receives the field", async () => {
  const { adapter, captured, restore } = reasoningAdapter(undefined);
  try {
    await adapter.generate({ messages: [{ role: "user", content: "hi" }], reasoningEffort: "deep" } as any);
    assert.equal(captured[0].reasoning_effort, undefined, "unsupported model — setting ignored, not pretended");
  } finally { restore(); }
});
