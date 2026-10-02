import assert from "node:assert/strict";
import test from "node:test";
import { progressRows, terminalRunStatus } from "./agentProgress.ts";

test("tool events update one chronological row with command and result", () => {
  const rows = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "c1", tool: "terminal" } },
    { sequence: 2, type: "tool.input", data: { callId: "c1", input: { command: "npm test" } } },
    { sequence: 3, type: "tool.completed", data: { callId: "c1", tool: "terminal", envelope: { userSummary: "Tests passed" } } },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.detail, "Tests passed");
  assert.equal(rows[0]?.state, "done");
});

test("file edits and verification appear as distinct progress steps", () => {
  const rows = progressRows([
    { sequence: 1, type: "file.edit", data: { path: "src/app.ts" } },
    { sequence: 2, type: "verification.completed", data: { verdict: "PASS" } },
  ]);
  assert.deepEqual(rows.map((row) => [row.label, row.state]), [["Updated file", "done"], ["Reviewed changes", "done"]]);
});

test("GitHub MCP actions are identified for the branded progress icon", () => {
  const [row] = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "gh1", tool: "mcp.github.create_pull_request" } },
  ]);
  assert.equal(row?.integration, "github");
  assert.equal(row?.label, "Using GitHub: create pull request");
});

test("only settled run statuses stop the live indicator", () => {
  assert.equal(terminalRunStatus("running"), false);
  assert.equal(terminalRunStatus("completed"), true);
});
