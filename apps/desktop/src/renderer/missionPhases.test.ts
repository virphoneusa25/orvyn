import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveMissionPhases } from "./missionPhases.ts";

let n = 0;
const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data, id: `e${++n}` });
const tool = (callId: string, name: string, input: Record<string, unknown>) => [
  ev("tool.started", { callId, tool: name }),
  ev("tool.input", { callId, tool: name, input }),
  ev("tool.completed", { callId, tool: name }),
];

test("a plain reply has no mission timeline", () => {
  assert.equal(deriveMissionPhases([ev("message.delta", { content: "Hi" })], "completed"), null);
});

test("the timeline follows the real steps and ends Verified after tests", () => {
  const running = [...tool("a", "search_codebase", { query: "checkout" }), ev("tool.started", { callId: "b", tool: "edit_file" }), ev("tool.input", { callId: "b", tool: "edit_file", input: { path: "src/pay.ts" } })];
  const live = deriveMissionPhases(running, "running")!;
  assert.deepEqual(live.phases.map((p) => p.state), ["done", "done", "active", "pending", "pending", "pending"]);
  assert.equal(live.status, "running");
  const done = deriveMissionPhases([...running, ev("tool.completed", { callId: "b", tool: "edit_file" }), ...tool("c", "terminal", { command: "npm test" }), ev("run.completed")], "completed")!;
  assert.deepEqual(done.phases.map((p) => p.state), ["done", "done", "done", "done", "skipped", "done"]);
  assert.equal(done.status, "verified");
});

test("reading back a file the run wrote counts as verifying it", () => {
  const events = [...tool("a", "write_file", { path: "hello.txt" }), ...tool("b", "read_file", { path: "./hello.txt" })];
  const v = deriveMissionPhases(events, "completed")!;
  assert.equal(v.phases.find((p) => p.name === "Verify")!.state, "done");
  assert.equal(v.phases.find((p) => p.name === "Inspect")!.state, "skipped");
});

test("web research is part of Inspect; a failed run marks the active step", () => {
  const events = [...tool("a", "web_search", { query: "vite hmr" }), ev("tool.started", { callId: "b", tool: "terminal" }), ev("tool.input", { callId: "b", tool: "terminal", input: { command: "npm run build" } })];
  const v = deriveMissionPhases(events, "error")!;
  assert.equal(v.phases.find((p) => p.name === "Inspect")!.state, "done");
  assert.equal(v.phases.find((p) => p.name === "Act")!.state, "failed");
  assert.equal(v.status, "attention");
});
