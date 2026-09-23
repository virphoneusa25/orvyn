// Unit tests for the conversation presentation reducer — the layer that
// guarantees the center stream shows a conversation, not an event dump.
// Run via node --test (type stripping), same as orvynIntent.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducePresentation, splitPath } from "./presentationReducer.ts";
import type { AgentEventLike, ToolItem, WorkGroupItem as WgItem } from "./presentationReducer.ts";

let seq = 0;
function ev(type: string, data: Record<string, any> = {}): AgentEventLike {
  return { id: `e${seq}`, sequence: seq++, type, timestamp: 1000 + seq * 300, data };
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
  // One read = one inspection workgroup holding exactly one child row.
  const wgs = items.filter((i) => i.kind === "workgroup") as WgItem[];
  assert.equal(wgs.length, 1, "one group, not three rows");
  assert.equal(wgs[0].items.length, 1, "single child — lifecycle never duplicated");
  const t = wgs[0].items[0];
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

test("assistant deltas accumulate into one message; a preceding thought persists as a timed row", () => {
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
  assert.equal(items.length, 2);
  const thought = items[0] as { kind: string; label: string; thought?: { endTs?: number } };
  assert.equal(thought.kind, "status");
  assert.equal(thought.label, "Thought");
  assert.ok(thought.thought?.endTs, "thought duration closed by the following activity");
  const msg = items[1] as { kind: string; content: string };
  assert.equal(msg.kind, "assistant");
  assert.equal(msg.content, "I'll inspect the project.");
});

test("consecutive thinking events merge into ONE thought row", () => {
  reset();
  const items = reducePresentation(
    [ev("thinking", { role: "astra" }), ev("thinking", { role: "astra" }), ev("thinking", { role: "astra" })],
    "running"
  );
  const thoughts = items.filter((i) => i.kind === "status");
  assert.equal(thoughts.length, 1, "one merged row, not three");
});

test("an in-progress run keeps its assistant buffer streaming", () => {
  reset();
  const items = reducePresentation([ev("message.delta", { content: "Working on " })], "running");
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, "assistant");
  assert.equal((items[0] as { streaming: boolean }).streaming, true);
});

test("consecutive reads roll into one inspection WorkGroup; edits and checks form their own groups", () => {
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
  const wgs = items.filter((i) => i.kind === "workgroup") as WgItem[];
  assert.equal(wgs.length, 3, "inspection + edits + checks = three phase groups, not 10 rows");
  const [insp, edits, checks] = wgs;
  assert.equal(insp.type, "inspection");
  assert.equal(insp.title, "Explore");
  assert.ok(String(insp.summary).includes("8 files"), `summary counts files (got: ${insp.summary})`);
  assert.equal(insp.items.length, 8, "expandable to the individual reads");
  assert.equal(edits.type, "edits");
  assert.equal(edits.title, "Updated keep.ts");
  assert.match(String(edits.summary), /^\+1 −1/);
  assert.equal(edits.ctx, "diff");
  assert.equal(checks.type, "checks");
  assert.equal(checks.summary, "67 passed");
  assert.equal(checks.ctx, "terminal");
  assert.equal(items.filter((i) => i.kind === "tool").length, 0, "no loose rows outside the groups");
});

test("assistant text between reads splits the phases into separate groups", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "a", tool: "read_file" }),
      ev("tool.completed", { callId: "a", tool: "read_file", preview: "x" }),
      ev("message.delta", { content: "Found it. Reading the config next." }),
      ev("message.completed", {}),
      ev("tool.started", { callId: "b", tool: "read_file" }),
      ev("tool.completed", { callId: "b", tool: "read_file", preview: "y" }),
    ],
    "completed"
  );
  assert.equal(items.filter((i) => i.kind === "workgroup").length, 2, "text between work closes the group");
  assert.ok(items.some((i) => i.kind === "assistant"));
});

test("a running inspection reports running state and phase title", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "r1", tool: "read_file" }),
      ev("tool.input", { callId: "r1", tool: "read_file", input: { path: "a.ts" } }),
    ],
    "running"
  );
  const wg = items.find((i) => i.kind === "workgroup") as WgItem;
  assert.equal(wg.status, "running");
  assert.equal(wg.title, "Explore");
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
  const wg = items.find((i) => i.kind === "workgroup") as WgItem;
  assert.ok(wg, "failed command still presented");
  assert.equal(wg.status, "failed", "all-failed group reads as failed");
  const failed = wg.items[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Exit 1");
  assert.ok(items.some((i) => i.kind === "status" && String((i as { label: string }).label).includes("connection closed")));
});


test("real runtime input without tool name preserves file and command identity", () => {
  for (const [tool, input, op, name] of [
    ["read_file", { path: "src/main.py" }, "read", "main.py"],
    ["terminal", { command: "python main.py" }, "terminal", undefined],
  ] as const) {
    const items = reducePresentation([ev("tool.started", { callId: "c", tool }), ev("tool.input", { callId: "c", input })], "running");
    const item = (items[0] as WgItem).items[0];
    assert.equal(item.op, op);
    assert.equal(item.fileName, name);
    if (op === "terminal") assert.equal(item.label, "python main.py");
  }
});

test("terminal output is correlated, bounded, and failure survives lifecycle completion", () => {
  const items = reducePresentation([
    ev("tool.started", { callId: "a", tool: "terminal" }),
    ev("tool.started", { callId: "b", tool: "terminal" }),
    ev("terminal.output", { callId: "a", data: "a".repeat(17000) }),
    ev("terminal.output", { callId: "b", data: "second command" }),
    ev("terminal.completed", { callId: "a", exitOk: false }),
    ev("tool.completed", { callId: "a" }),
  ], "running");
  const [a, b] = (items[0] as WgItem).items;
  assert.equal(a.output?.length, 16000);
  assert.equal(a.outputTruncated, true);
  assert.equal(a.status, "failed");
  assert.equal(b.output, "second command");
});

test("finished and cancelled runs preserve unfinished text without stale thinking", () => {
  const items = reducePresentation([ev("thinking"), ev("tool.started", { callId: "a", tool: "read_file" }), ev("message.delta", { content: "Partial reply" })], "cancelled");
  const wg = items.find(i => i.kind === "workgroup") as WgItem;
  assert.equal(wg.items[0].status, "stopped");
  assert.ok(items.some(i => i.kind === "assistant" && i.content === "Partial reply" && !i.streaming));
  assert.ok(!items.some(i => i.kind === "status" && i.ephemeral));
});

test("thinking merges to one thought row and text remains chronological", () => {
  const items = reducePresentation([ev("message.delta", { content: "I found the entry point." }), ev("thinking"), ev("thinking")], "running");
  assert.equal(items[0].kind, "assistant");
  assert.equal(items.filter(i => i.kind === "status").length, 1);
});

test("blocked and partial missions never present successful completion", () => {
  for (const data of [{ missionStatus: "BLOCKED", tasksTotal: 5, tasksCompleted: 1 }, { tasksFailed: 1 }]) {
    const item = reducePresentation([ev("run.completed", data)], "completed")[0];
    assert.equal(item.kind, "summary");
    if (item.kind === "summary") assert.equal(item.ok, false);
  }
  const item = reducePresentation([ev("run.completed", { steps: 3 })], "completed")[0];
  if (item.kind === "summary") assert.equal(item.detail, "Completed");
});

test("search + read collapse into Explore · N searches, N files", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "s", tool: "search_codebase" }),
      ev("tool.input", { callId: "s", tool: "search_codebase", input: { query: "initChatHistory" } }),
      ev("tool.completed", { callId: "s", tool: "search_codebase", preview: "2 results" }),
      ev("tool.started", { callId: "r", tool: "read_file" }),
      ev("tool.input", { callId: "r", tool: "read_file", input: { path: "src/App.tsx" } }),
      ev("tool.completed", { callId: "r", tool: "read_file", preview: "x" }),
    ],
    "completed"
  );
  const wg = items.find((i) => i.kind === "workgroup") as WgItem;
  assert.equal(wg.title, "Explore");
  assert.match(String(wg.summary), /^1 search, 1 file/);
});

test("agent.phase becomes a safe Thought row, never private reasoning", () => {
  reset();
  const items = reducePresentation(
    [ev("agent.phase", { phase: "DISCOVER", note: "Gathering relevant context" })],
    "running"
  );
  const thought = items.find((i) => i.kind === "status") as { label: string; thought?: { summary?: string } };
  assert.equal(thought.label, "Thought");
  assert.equal(thought.thought?.summary, "Gathering relevant context");
  assert.ok(!JSON.stringify(items).includes("reasoningContent"));
});

test("replay of the same sequence is idempotent — no duplicate rows", () => {
  reset();
  const events = [
    ev("message.delta", { content: "Checking restore." }),
    ev("message.completed", {}),
    ev("tool.started", { callId: "c1", tool: "search_codebase" }),
    ev("tool.input", { callId: "c1", tool: "search_codebase", input: { query: "active run" } }),
    ev("tool.completed", { callId: "c1", tool: "search_codebase", preview: "1 result" }),
    ev("run.completed", { steps: 1 }),
  ];
  const first = reducePresentation(events, "completed");
  const again = reducePresentation(events, "completed");
  assert.deepEqual(
    first.map((i) => i.kind + ":" + i.key),
    again.map((i) => i.kind + ":" + i.key)
  );
  assert.equal(first.filter((i) => i.kind === "summary").length, 1);
});

test("diff counts attach to exact paths when basenames collide", () => {
  const events = ["src/app.ts", "tests/app.ts"].flatMap((path, i) => [ev("tool.started", { callId: String(i), tool: "edit_file" }), ev("tool.input", { callId: String(i), input: { path } })]);
  events.push(ev("file.edit", { path: "src/app.ts", preview: { additions: 4, deletions: 2 } }));
  const [a, b] = (reducePresentation(events, "running")[0] as WgItem).items;
  assert.equal(a.detail, "+4 −2");
  assert.equal(b.detail, undefined);
});

test("artifact.created becomes a downloadable attachment card", () => {
  reset();
  const items = reducePresentation(
    [
      ev("artifact.created", {
        id: "art_logo1",
        name: "virphone-logo.png",
        kind: "generated",
        mediaType: "image/png",
        downloadPath: "/artifacts/art_logo1/download",
      }),
    ],
    "completed"
  );
  const card = items.find((i) => i.kind === "attachment") as { name: string; artifactId?: string; downloadPath?: string };
  assert.ok(card);
  assert.equal(card.name, "virphone-logo.png");
  assert.equal(card.artifactId, "art_logo1");
  assert.equal(card.downloadPath, "/artifacts/art_logo1/download");
});

test("capability.required becomes a chat card, not a tool dump", () => {
  reset();
  const items = reducePresentation(
    [
      ev("capability.required", {
        query: "create a pull request",
        reason: "ORION needs GitHub to create a pull request.",
        recommendedServers: [{ name: "GitHub" }],
        runId: "run_1",
      }),
    ],
    "running"
  );
  const card = items.find((i) => i.kind === "capability") as { reason: string; recommendedServers: { name?: string }[] };
  assert.ok(card);
  assert.match(card.reason, /GitHub/);
  assert.equal(card.recommendedServers[0]?.name, "GitHub");
});
