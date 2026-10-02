import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusLabel, progressRows, terminalRunStatus } from "./agentProgress.ts";

test("tool events update one chronological row with command and result", () => {
  const rows = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "c1", tool: "terminal" } },
    { sequence: 2, type: "tool.input", data: { callId: "c1", input: { command: "npm test" } } },
    { sequence: 3, type: "tool.completed", data: { callId: "c1", tool: "terminal", envelope: { userSummary: "Tests passed" } } },
  ], "running");
  const work = rows.filter((row) => row.id.startsWith("tool:"));
  assert.equal(work.length, 1);
  assert.equal(work[0]?.detail, "Tests passed");
  assert.equal(work[0]?.state, "done");
  assert.equal(work[0]?.kind, "command");
});

test("file edits and verification appear as distinct progress steps", () => {
  const rows = progressRows([
    { sequence: 1, type: "file.edit", data: { path: "src/app.ts" } },
    { sequence: 2, type: "verification.completed", data: { verdict: "PASS" } },
  ], "running");
  assert.deepEqual(rows.filter((row) => !row.id.startsWith("stage:")).map((row) => [row.label, row.state]), [["Updated file", "done"], ["Reviewed changes", "done"]]);
});

test("GitHub MCP actions are identified for the branded progress icon", () => {
  const [row] = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "gh1", tool: "mcp.github.create_pull_request" } },
  ], "running").filter((item) => item.id.startsWith("tool:"));
  assert.equal(row?.integration, "github");
  assert.equal(row?.label, "Using GitHub: create pull request");
});

test("duplicate failed reads on one host collapse to a single public error", () => {
  const rows = progressRows([
    { sequence: 1, type: "tool.started", data: { callId: "a", tool: "fetch_url", args: { url: "https://www.virphoneusa.com/" } } },
    { sequence: 2, type: "tool.failed", data: { callId: "a", tool: "fetch_url", envelope: { userSummary: "Could not read https://www.virphoneusa.com/: HTTP 401 Forbidden. OpenShell will not allow host *." } } },
    { sequence: 3, type: "tool.started", data: { callId: "b", tool: "fetch_url", args: { url: "https://www.virphoneusa.com/pricing" } } },
    { sequence: 4, type: "tool.failed", data: { callId: "b", tool: "fetch_url", envelope: { userSummary: "Could not read https://www.virphoneusa.com/pricing: HTTP 401." } } },
  ], "running");
  const reads = rows.filter((row) => row.label === "Reading a page");
  assert.equal(reads.length, 1);
  assert.equal(reads[0]?.state, "failed");
  assert.doesNotMatch(String(reads[0]?.detail), /OpenShell|host \*/);
});

test("only settled run statuses stop the live indicator", () => {
  assert.equal(terminalRunStatus("running"), false);
  assert.equal(terminalRunStatus("completed"), true);
});

test("lifecycle is a flat Introducing / tools / Checking ledger, not an Acting accordion", () => {
  const live = progressRows([
    { sequence: 1, type: "run.phase.changed", data: { phase: "introducing" } },
    { sequence: 2, type: "run.phase.changed", data: { phase: "acting" } },
    { sequence: 3, type: "tool.started", data: { callId: "s1", tool: "search_capabilities" } },
    { sequence: 4, type: "tool.completed", data: { callId: "s1", tool: "search_capabilities" } },
    { sequence: 5, type: "run.phase.changed", data: { phase: "verifying" } },
  ], "running");
  assert.deepEqual(live.map((row) => [row.id, row.label, row.state, row.kind]), [
    ["stage:introducing", "Introducing", "done", "plan"],
    ["tool:s1", "Using search capabilities", "done", "search"],
    ["stage:checking", "Checking the result", "running", "review"],
  ]);
  const done = progressRows([
    { sequence: 1, type: "run.phase.changed", data: { phase: "introducing" } },
    { sequence: 2, type: "tool.completed", data: { callId: "s1", tool: "search_capabilities" } },
    { type: "run.completed" },
  ], "completed");
  assert.ok(done.every((row) => row.state === "done"));
  assert.equal(liveStatusLabel([{ type: "run.phase.changed", data: { phase: "verifying" } }], "running"), "Checking the result");
});
