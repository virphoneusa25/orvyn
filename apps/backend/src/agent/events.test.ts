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

// ---- Durable ordered queue --------------------------------------------------

test("queue: add/list keeps FIFO order; empty text and terminal runs rejected", () => {
  const store = new RunStore();
  store.create("run-q1", "C:/proj");
  const a = store.queueAdd("run-q1", "Add tests");
  const b = store.queueAdd("run-q1", "  Fix the README  ");
  assert.ok(a && b, "both items accepted on a live run");
  assert.deepEqual(
    store.queueList("run-q1").map((i) => i.text),
    ["Add tests", "Fix the README"],
    "listed in add order; text trimmed"
  );
  assert.equal(store.queueAdd("run-q1", "   "), null, "whitespace-only text rejected");
  assert.equal(store.queueAdd("run-missing", "x"), null, "unknown run rejected");

  store.setStatus("run-q1", "completed");
  assert.equal(store.queueAdd("run-q1", "late"), null, "terminal runs cannot take new queue items");
});

test("queue: reorder is atomic — a wrong id or count rejects the whole change", () => {
  const store = new RunStore();
  store.create("run-q2", "C:/proj");
  const a = store.queueAdd("run-q2", "A")!;
  const b = store.queueAdd("run-q2", "B")!;
  const c = store.queueAdd("run-q2", "C")!;
  assert.equal(store.queueReorder("run-q2", [c.id, b.id, "q_bogus"]), false, "unknown id rejects");
  assert.equal(store.queueReorder("run-q2", [c.id, b.id]), false, "wrong count rejects");
  assert.equal(store.queueReorder("run-q2", [c.id, a.id, b.id]), true);
  assert.deepEqual(
    store.queueList("run-q2").map((i) => i.id),
    [c.id, a.id, b.id],
    "new order holds"
  );
});

test("queue: update, delete, steer, mark-delivered — each removes the item from the live list", () => {
  const store = new RunStore();
  store.create("run-q3", "C:/proj");
  const a = store.queueAdd("run-q3", "Original")!;
  const b = store.queueAdd("run-q3", "Keep me")!;

  assert.equal(store.queueUpdate("run-q3", a.id, "Edited"), true);
  assert.equal(store.queueUpdate("run-q3", a.id, "  "), false, "empty edit rejected");
  assert.equal(store.queueList("run-q3")[0].text, "Edited");

  assert.equal(store.queueDelete("run-q3", b.id), true);
  assert.deepEqual(store.queueList("run-q3").map((i) => i.id), [a.id], "deleted item gone");
  assert.equal(store.queueDelete("run-q3", b.id), false, "double delete rejected");

  // Steer moves the item into the run's steer buffer and out of the queue.
  assert.equal(store.queueSteer("run-q3", a.id), true);
  assert.deepEqual(store.takeSteer("run-q3"), ["Edited"], "steered text reaches the run");
  assert.deepEqual(store.queueList("run-q3"), [], "steered item no longer queued");

  // Delivered marker (client sends the follow-up as a new run).
  const d = store.queueAdd("run-q3", "Follow-up")!;
  assert.equal(store.queueMarkDelivered("run-q3", d.id), true);
  assert.deepEqual(store.queueList("run-q3"), [], "delivered item no longer queued");

  // Steer is refused once the run is terminal — a dead buffer must not eat items.
  store.setStatus("run-q3", "completed");
  const e = store.queueAdd("run-q3", "should fail")!;
  assert.equal(e, null, "add also refused on terminal run");
});

test("queue: survives a backend restart — replay rebuilds items, edits, order, and consumption", () => {
  const dir = mkdtempSync(join(tmpdir(), "orvyn-runs-"));
  try {
    const live = new RunStore(dir);
    live.create("run-qq", "C:/proj");
    const a = live.queueAdd("run-qq", "First")!;
    const b = live.queueAdd("run-qq", "Second")!;
    live.queueAdd("run-qq", "Typo wrods");
    const typo = live.queueList("run-qq").find((i) => i.text === "Typo wrods")!;
    live.queueUpdate("run-qq", typo.id, "Typo words");
    const c = live.queueList("run-qq").find((i) => i.text === "Typo words")!;
    live.queueReorder("run-qq", [a.id, c.id, b.id]);
    live.queueDelete("run-qq", a.id);
    live.queueSteer("run-qq", c.id);
    const d = live.queueAdd("run-qq", "Stays queued")!;
    live.queueMarkDelivered("run-qq", d.id);
    live.emit("run-qq", "run.completed", { tasksTotal: 1, tasksCompleted: 1 });
    live.setStatus("run-qq", "completed");

    // "Restart": only b ("Second") is still queued, in the right shape.
    const revived = new RunStore(dir);
    const items = revived.queueList("run-qq");
    assert.deepEqual(
      items.map((i) => i.text),
      ["Second"],
      "created+edited survive; deleted/steered/delivered stay consumed"
    );
    assert.equal(items[0].status, "queued");
    assert.equal(items[0].position >= 0, true, "position replayed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("terminal output emits a normalized preview.available event once", () => {
  const store = new RunStore();
  store.create("run-prev", "C:/proj");
  store.emit("run-prev", "terminal.output", { data: "VITE ready\n  Local: http://127.0.0.1:43191/\n" });
  store.emit("run-prev", "terminal.output", { data: "Local: http://127.0.0.1:43191/\n" });
  const previews = store.get("run-prev")!.events.filter((e) => e.type === "preview.available");
  assert.equal(previews.length, 1);
  assert.equal(previews[0]!.data.url, "http://127.0.0.1:43191/");
});

test("queue: reconnect fetch (queueList) never resurrects consumed items", () => {
  const store = new RunStore();
  store.create("run-qr", "C:/proj");
  store.queueAdd("run-qr", "one");
  const two = store.queueAdd("run-qr", "two")!;
  store.queueDelete("run-qr", two.id);
  assert.deepEqual(
    store.queueList("run-qr").map((i) => i.text),
    ["one"]
  );
});
