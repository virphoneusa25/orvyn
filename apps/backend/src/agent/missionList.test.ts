import { test } from "node:test";
import assert from "node:assert/strict";
import { composerRunsAsMissions, goalFromRunEvents } from "./missionList";

test("composer runs become mission rows titled from the user prompt", () => {
  const rows = composerRunsAsMissions(
    [
      {
        id: "run_a",
        status: "completed",
        createdAt: 10,
        events: [{ type: "run.started", data: { instruction: "Build a landing page" } }],
      },
      {
        id: "run_b",
        status: "error",
        createdAt: 20,
        events: [],
      },
    ],
    new Set(["run_taken"]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].goal, "Build a landing page");
  assert.equal(rows[0].status, "COMPLETED");
  assert.equal(rows[0].runId, "run_a");
  assert.equal(rows[1].goal, "Untitled run");
  assert.equal(rows[1].status, "FAILED");
});

test("a run that is already a TaskEngine mission is not listed twice", () => {
  const rows = composerRunsAsMissions(
    [{ id: "run_taken", status: "running", createdAt: 1, events: [{ type: "run.started", data: { instruction: "dup" } }] }],
    new Set(["run_taken"]),
  );
  assert.deepEqual(rows, []);
});

test("goalFromRunEvents ignores events that are not the start", () => {
  assert.equal(goalFromRunEvents([{ type: "message.delta", data: { content: "hello" } }]), "Untitled run");
});
