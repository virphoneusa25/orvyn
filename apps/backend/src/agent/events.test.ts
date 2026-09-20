// apps/backend/src/agent/events.test.ts
//
// Pins the durability contract: events appended as they stream are replayed
// by a fresh RunStore over the same directory — a backend restart must not
// erase finished runs' history or break reconnect replay.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore } from "./events";

test("run events survive a store restart (boot replay from the JSONL log)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-runs-"));
  try {
    const live = new RunStore(dir);
    live.create("run-aaa", "C:/proj");
    live.emit("run-aaa", "run.started", { instruction: "inspect" });
    live.emit("run-aaa", "message.delta", { content: "hello" });
    live.setStatus("run-aaa", "awaiting_approval");
    live.emit("run-aaa", "approval.required", { callId: "c1" });
    live.emit("run-aaa", "approval.resolved", { callId: "c1", approved: true });
    live.setStatus("run-aaa", "running");
    live.addUsage("run-aaa", { promptTokens: 10, completionTokens: 5 });
    live.emit("run-aaa", "run.completed", { tasksTotal: 1, tasksCompleted: 1 });
    live.setStatus("run-aaa", "completed");

    // "Restart": a brand-new store over the same directory.
    const revived = new RunStore(dir);
    const run = revived.get("run-aaa");
    assert.ok(run, "run replayed from disk");
    assert.equal(run.status, "completed", "terminal status replayed from the meta line");
    assert.equal(run.projectRoot, "C:/proj");
    assert.equal(run.events.length, 5, "all events replayed in order");
    assert.deepEqual(
      run.events.map((e) => e.type),
      ["run.started", "message.delta", "approval.required", "approval.resolved", "run.completed"]
    );
    assert.equal(run.nextSequence, 6, "sequence cursor continues after the highest replayed event");
    assert.equal(run.usage.promptTokens, 10, "usage totals replayed");
    assert.equal(revived.eventsAfter("run-aaa", 2).length, 3, "resume-after cursor works post-restart");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("intermediate statuses replay as the LAST meta line, not the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-runs-"));
  try {
    const live = new RunStore(dir);
    live.create("run-bbb", "C:/proj");
    live.setStatus("run-bbb", "awaiting_approval");
    live.setStatus("run-bbb", "running");
    live.setStatus("run-bbb", "error");

    const revived = new RunStore(dir);
    assert.equal(revived.get("run-bbb")?.status, "error");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in-memory store still works with no directory (durability opt-out)", () => {
  const store = new RunStore();
  store.create("run-ccc", "C:/proj");
  store.emit("run-ccc", "run.started", { instruction: "x" });
  assert.equal(store.get("run-ccc")?.events.length, 1);
});

test("a run that was in-flight at shutdown replays as an honest error, not a ghost", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-runs-"));
  try {
    const live = new RunStore(dir);
    live.create("run-ddd", "C:/proj");
    live.emit("run-ddd", "run.started", { instruction: "long work" });
    live.setStatus("run-ddd", "awaiting_approval"); // process dies here

    const revived = new RunStore(dir);
    const run = revived.get("run-ddd");
    assert.equal(run?.status, "error", "non-terminal run replayed as error");
    const last = run?.events[run.events.length - 1];
    assert.equal(last?.type, "run.error");
    assert.match(String(last?.data.message), /restarted/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("steer: queued on a live run, drained once at the boundary, rejected when terminal", () => {
  const store = new RunStore();
  store.create("run-st", "C:/proj");
  assert.equal(store.steer("run-st", "Keep it short."), true);
  assert.equal(store.steer("run-st", ""), false, "empty text rejected");
  assert.equal(store.steer("run-missing", "x"), false);
  const drained = store.takeSteer("run-st");
  assert.deepEqual(drained, ["Keep it short."]);
  assert.deepEqual(store.takeSteer("run-st"), [], "drained exactly once");
  store.setStatus("run-st", "completed");
  assert.equal(store.steer("run-st", "late"), false, "terminal runs cannot be steered");
});
