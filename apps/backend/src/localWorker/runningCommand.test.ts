import { test } from "node:test";
import assert from "node:assert/strict";
import { runningCommandCallId } from "../routes/localWorker";

test("Local Worker output attaches to the command that is running now", () => {
  const ev = (type: string, data: Record<string, unknown>) => ({ type, data });
  assert.equal(runningCommandCallId([ev("tool.started", { callId: "a", tool: "write_file" })]), undefined);
  const events = [
    ev("tool.started", { callId: "c1", tool: "terminal" }),
    ev("tool.completed", { callId: "c1", tool: "terminal" }),
    ev("tool.started", { callId: "c2", tool: "run_tests" }),
  ];
  assert.equal(runningCommandCallId(events), "c2");
  assert.equal(runningCommandCallId([...events, ev("tool.failed", { callId: "c2", tool: "run_tests" })]), undefined);
});
