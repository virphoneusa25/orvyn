import { test } from "node:test";
import assert from "node:assert/strict";
import { RunStore } from "./events";
import { finalAnswerOf, summarizeRuns, threadHistory } from "./runThread";

function run(store: RunStore, id: string, instruction: string, answer: string, at = 0) {
  const r = store.create(id, "/p");
  r.createdAt = at;
  store.emit(id, "run.started", { instruction });
  store.emit(id, "message.delta", { content: "Let me check." });
  store.emit(id, "tool.completed", { tool: "write_file", callId: "c", envelope: { userSummary: `Wrote ${id}.txt · 5 bytes` } });
  store.emit(id, "message.delta", { content: answer });
  store.setStatus(id, "completed");
}

test("the session's runs are the model's history, oldest first", () => {
  const store = new RunStore();
  run(store, "r1", "Create hello.txt", "Created hello.txt.", 1);
  run(store, "r2", "Now read it", "It says Hello.", 2);
  run(store, "r3", "Unrelated", "Other.", 3);
  assert.deepEqual(summarizeRuns(store, ["r1", "r2", "gone"]).map((r) => [r.runId, r.instruction, r.status]), [["r1", "Create hello.txt", "completed"], ["r2", "Now read it", "completed"], ["gone", "", "unavailable"]]);
  const h = threadHistory(store, ["r2", "r1"]);
  assert.deepEqual(h.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(h[0]!.content, "Create hello.txt");
  assert.match(h[1]!.content, /Wrote r1\.txt · 5 bytes/);
  assert.match(h[1]!.content, /Created hello\.txt\.$/);
  assert.doesNotMatch(h[1]!.content, /Let me check/, "mid-run narration is not the answer");
  assert.equal(h[2]!.content, "Now read it");
  assert.ok(!JSON.stringify(h).includes("Unrelated"), "other sessions stay out");
});

test("the newest turns win when history is over budget", () => {
  const store = new RunStore();
  run(store, "a", "x".repeat(5000), "A", 1);
  run(store, "b", "second", "B", 2);
  const h = threadHistory(store, ["a", "b"], 1000);
  assert.deepEqual(h.map((m) => m.content.slice(0, 6)), ["second", "Work d"]);
  assert.equal(finalAnswerOf(store.get("b")!.events), "B");
});
