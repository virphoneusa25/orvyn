import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusLabel, progressRows, terminalRunStatus } from "./agentProgress.ts";

test("tool events update one chronological row with command and result", () => {
  const rows = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "c1", tool: "terminal" } },
    { sequence: 2, type: "tool.input", data: { callId: "c1", input: { command: "npm test" } } },
    { sequence: 3, type: "tool.completed", data: { callId: "c1", tool: "terminal", envelope: { userSummary: "Tests passed" } } },
  ], "running");
  const work = rows.filter((row) => row.nested);
  assert.equal(work.length, 1);
  assert.equal(work[0]?.detail, "Tests passed");
  assert.equal(work[0]?.state, "done");
});

test("file edits and verification appear as distinct progress steps", () => {
  const rows = progressRows([
    { sequence: 1, type: "file.edit", data: { path: "src/app.ts" } },
    { sequence: 2, type: "verification.completed", data: { verdict: "PASS" } },
  ], "running");
  assert.deepEqual(rows.filter((row) => row.nested).map((row) => [row.label, row.state]), [["Updated file", "done"], ["Reviewed changes", "done"]]);
});

test("GitHub MCP actions are identified for the branded progress icon", () => {
  const [row] = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "gh1", tool: "mcp.github.create_pull_request" } },
  ], "running").filter((item) => item.nested);
  assert.equal(row?.integration, "github");
  assert.equal(row?.label, "Using GitHub: create pull request");
});

test("only settled run statuses stop the live indicator", () => {
  assert.equal(terminalRunStatus("running"), false);
  assert.equal(terminalRunStatus("completed"), true);
});

test("lifecycle phases update one Introducing / Acting / Checking accordion in place", () => {
  const live = progressRows([
    { sequence: 1, type: "run.phase.changed", data: { phase: "introducing" } },
    { sequence: 2, type: "run.phase.changed", data: { phase: "acting" } },
    { sequence: 3, type: "run.phase.changed", data: { phase: "verifying" } },
    { sequence: 4, type: "message.delta", data: { content: "What's the project?" } },
  ], "running");
  assert.deepEqual(live.filter((row) => !row.nested).map((row) => [row.label, row.state]), [
    ["Introducing", "done"],
    ["Acting", "done"],
    ["Checking the result", "running"],
  ]);
  const done = progressRows(live.length ? [
    { sequence: 1, type: "run.phase.changed", data: { phase: "introducing" } },
    { sequence: 2, type: "run.phase.changed", data: { phase: "acting" } },
    { sequence: 3, type: "run.phase.changed", data: { phase: "verifying" } },
    { type: "run.completed" },
  ] : [], "completed");
  assert.ok(done.filter((row) => !row.nested).every((row) => row.state === "done"));
  assert.equal(liveStatusLabel([{ type: "run.phase.changed", data: { phase: "verifying" } }], "running"), "Checking the result");
});
