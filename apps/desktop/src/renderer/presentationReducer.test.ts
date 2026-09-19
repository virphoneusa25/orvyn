// Unit tests for the conversation presentation reducer — the layer that
// guarantees the center stream shows a conversation, not an event dump.
// Run via node --test (type stripping), same as orvynIntent.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducePresentation, splitPath } from "./presentationReducer.ts";
import type { AgentEventLike, ToolItem } from "./presentationReducer.ts";

let seq = 0;
function ev(type: string, data: Record<string, any> = {}): AgentEventLike {
  return { id: `e${seq}`, sequence: seq++, type, data };
}
function reset() {
  seq = 0;
}

test("splitPath: filename, muted path, uppercase ext", () => {
  const p = splitPath("src/auth/session.ts");
  assert.equal(p.fileName, "session.ts");
  assert.equal(p.path, "src/auth/");
  assert.equal(p.ext, "TS");
  assert.equal(splitPath("README.md").ext, "MD");
  assert.equal(splitPath("Dockerfile").ext, undefined);
  assert.equal(splitPath("a\\b\\c.json").fileName, "c.json");
});

test("a tool's lifecycle collapses into ONE row that updates in place", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "c1", tool: "read_file" }),
      ev("tool.input", { callId: "c1", tool: "read_file", input: { path: "src/app/main.ts" } }),
      ev("tool.completed", { callId: "c1", tool: "read_file", preview: "import…" }),
    ],
    "completed"
  );
  const tools = items.filter((i) => i.kind === "tool") as ToolItem[];
  assert.equal(tools.length, 1, "one row, not three");
  const t = tools[0];
  assert.equal(t.op, "read");
  assert.equal(t.fileName, "main.ts");
  assert.equal(t.ext, "TS");
  assert.equal(t.path, "src/app/");
  assert.equal(t.status, "done");
  assert.equal(t.ctx, "files");
});

test("raw internal events never render", () => {
  reset();
  const items = reducePresentation(
    [
      ev("run.started", { instruction: "x" }),
      ev("mission.created", {}),
      ev("task.started", {}),
      ev("agent.tool_call", { agent: "coder" }),
      ev("agent.started", {}),
      ev("usage.updated", {}),
      ev("context.compacted", {}),
      ev("sandbox.started", {}),
      ev("file.read", { path: "a.ts" }),
    ],
    "completed"
  );
  assert.equal(items.length, 0);
});

test("assistant deltas accumulate into one streaming message; raw statuses drop when superseded", () => {
  reset();
  const items = reducePresentation(
    [
      ev("thinking", { role: "astra" }),
      ev("message.delta", { content: "I'll inspect " }),
      ev("message.delta", { content: "the project." }),
      ev("message.completed", {}),
    ],
    "completed"
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.equal((items[0] as { content: string }).content, "I'll inspect the project.");
});

test("an in-progress run keeps its assistant buffer streaming", () => {
  reset();
  const items = reducePresentation([ev("message.delta", { content: "Working on " })], "running");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.equal((items[0] as { streaming: boolean }).streaming, true);
});

test("excessive reads group; edits and terminals never do", () => {
  reset();
  const events: AgentEventLike[] = [];
  for (let i = 0; i < 8; i++) {
    const id = `r${i}`;
    events.push(ev("tool.started", { callId: id, tool: "read_file" }));
    events.push(ev("tool.input", { callId: id, tool: "read_file", input: { path: `src/f${i}.ts` } }));
    events.push(ev("tool.completed", { callId: id, tool: "read_file", preview: "x" }));
  }
  const e1 = "e1";
  events.push(ev("tool.started", { callId: e1, tool: "edit_file" }));
  events.push(ev("tool.input", { callId: e1, tool: "edit_file", input: { path: "src/keep.ts" } }));
  events.push(ev("file.edit", { path: "src/keep.ts", preview: { path: "src/keep.ts", kind: "modify", additions: 1, deletions: 1 } }));
  events.push(ev("tool.completed", { callId: e1, tool: "edit_file", preview: "written" }));
  const t1 = "t1";
  events.push(ev("tool.started", { callId: t1, tool: "terminal" }));
  events.push(ev("tool.input", { callId: t1, tool: "terminal", input: { command: "npm test" } }));
  events.push(ev("tool.completed", { callId: t1, tool: "terminal", preview: "67 passed" }));

  const items = reducePresentation(events, "completed");
  const groups = items.filter((i) => i.kind === "group");
  assert.equal(groups.length, 1, "8 reads → one group");
  assert.equal((groups[0] as { items: unknown[] }).items.length, 8);
  const tools = items.filter((i) => i.kind === "tool") as ToolItem[];
  assert.equal(tools.length, 2, "edit + terminal stay individual");
  assert.ok(tools.some((t) => t.op === "edit" && t.fileName === "keep.ts" && t.detail === "+1 −1"));
  assert.ok(tools.some((t) => t.op === "terminal" && t.label === "npm test" && t.detail === "67 passed"));
});

test("five or fewer reads stay individual", () => {
  reset();
  const events: AgentEventLike[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `r${i}`;
    events.push(ev("tool.started", { callId: id, tool: "read_file" }));
    events.push(ev("tool.completed", { callId: id, tool: "read_file", preview: "x" }));
  }
  const items = reducePresentation(events, "completed");
  assert.equal(items.filter((i) => i.kind === "group").length, 0);
  assert.equal(items.filter((i) => i.kind === "tool").length, 5);
});

test("approval required → resolved shows settled state; cancelled run ends in a subtle Stopped summary", () => {
  reset();
  const items = reducePresentation(
    [
      ev("approval.required", { callId: "a1", tool: "terminal", input: { command: "npm install" }, destructive: false }),
      ev("approval.resolved", { callId: "a1", approved: true }),
      ev("run.cancelled", { reason: "Stopped by user" }),
    ],
    "cancelled"
  );
  const approval = items.find((i) => i.kind === "approval") as { settled: boolean; approved: boolean };
  assert.ok(approval);
  assert.equal(approval.settled, true);
  assert.equal(approval.approved, true);
  const summary = items[items.length - 1] as { kind: string; cancelled: boolean; detail: string };
  assert.equal(summary.kind, "summary");
  assert.equal(summary.cancelled, true);
  assert.equal(summary.detail, "Stopped");
});

test("failed tool keeps its error; model errors surface as a status line", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "f1", tool: "terminal" }),
      ev("tool.input", { callId: "f1", tool: "terminal", input: { command: "npm run nope" } }),
      ev("tool.failed", { callId: "f1", tool: "terminal", error: "Exit 1" }),
      ev("tool.failed", { tool: "model", error: "connection closed" }),
    ],
    "error"
  );
  const failed = items.find((i) => i.kind === "tool") as ToolItem;
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Exit 1");
  assert.ok(items.some((i) => i.kind === "status" && String((i as { label: string }).label).includes("connection closed")));
});
