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

test("routing: DOCKER_LOCAL falls back to LOCAL truthfully when Docker is down", async () => {
  const router = new ExecutionRouter();
  const d = await router.select({ preference: "DOCKER_LOCAL" });
  // On this test machine Docker may or may not be running — both outcomes
  // are valid; what must hold: the reason records the truth.
  if (d.location === "LOCAL") {
    assert.ok(d.reason.includes("Docker unavailable") || d.reason.includes("unavailable"), `reason mentions unavailability: ${d.reason}`);
    assert.ok(d.provider instanceof LocalExecutionProvider);
  } else {
    assert.equal(d.location, "DOCKER_LOCAL");
  }
});

test("routing: OVH_WORKER always falls back (not deployed)", async () => {
  const router = new ExecutionRouter();
  const d = await router.select({ preference: "OVH_WORKER" });
  assert.equal(d.location, "LOCAL", "OVH not deployed → falls back to LOCAL");
  assert.ok(d.reason.includes("OVH") && d.reason.includes("unavailable"), `truthful reason: ${d.reason}`);
});

test("routing: remote-flagged task falls back honestly when OVH unavailable", async () => {
  const router = new ExecutionRouter();
  const d = await router.select({ isRemote: true });
  assert.notEqual(d.location, "OVH_WORKER", "must not claim OVH");
  assert.ok(d.reason.includes("OVH"), `reason mentions OVH: ${d.reason}`);
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
