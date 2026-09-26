// Unit tests for the conversation presentation reducer — the layer that
// guarantees the center stream shows a conversation, not an event dump.
// Run via node --test (type stripping), same as orvynIntent.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { commandSummary, reducePresentation, splitPath } from "./presentationReducer.ts";
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

test("assistant deltas accumulate into one message; status notes do not stay in the chat", () => {
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
  assert.equal(items.length, 1, JSON.stringify(items));
  const msg = items[0] as { kind: string; content: string };
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
  assert.equal(edits.ctx, "files", "one edited file opens that file; several open Changes");
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

test("agent.phase shows the phase note live, never private reasoning, and leaves no row behind", () => {
  reset();
  const live = reducePresentation(
    [ev("agent.phase", { phase: "DISCOVER", note: "Gathering relevant context" })],
    "running"
  );
  const status = live.find((i) => i.kind === "status") as { label: string; ephemeral?: boolean };
  assert.equal(status.label, "Gathering relevant context");
  assert.equal(status.ephemeral, true);
  assert.ok(!JSON.stringify(live).includes("reasoningContent"));
  const done = reducePresentation(
    [ev("agent.phase", { phase: "DISCOVER", note: "Gathering relevant context" }), ev("message.delta", { content: "Done." }), ev("message.completed", {}), ev("run.completed", {})],
    "completed"
  );
  assert.ok(!done.some((i) => i.kind === "status"), JSON.stringify(done));
});

test("completion checks stay out of the chat; a running command shows its output live", () => {
  reset();
  const items = reducePresentation(
    [
      ev("message.delta", { content: "Running the tests." }),
      ev("message.completed", {}),
      ev("completion.blocked", { gate: "code", reasons: ["Code change was not verified with tests."] }),
      ev("tool.started", { callId: "t1", tool: "terminal" }),
      ev("tool.input", { callId: "t1", tool: "terminal", input: { command: "npm test" } }),
      ev("terminal.output", { callId: "t1", data: "ok 1 - add adds\n" }),
    ],
    "running"
  );
  assert.ok(!JSON.stringify(items).includes("Needs proof"));
  const rows = items.flatMap((i) => (i.kind === "workgroup" ? (i as { items: unknown[] }).items : i.kind === "tool" ? [i] : [])) as Array<{ status: string; output?: string }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "running");
  assert.match(rows[0].output ?? "", /ok 1 - add adds/);
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

test("assistant text mentioning a filename does not create a file card", () => {
  reset();
  const items = reducePresentation(
    [
      ev("message.delta", { content: "Your Virphone logo has been generated as virphone-logo.png. Download it from the card above." }),
      ev("message.completed", {}),
    ],
    "completed"
  );
  assert.equal(items.some((i) => i.kind === "attachment"), false);
});

test("tool.completed with artifactId also becomes an attachment card", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "c1", tool: "generate_image" }),
      ev("tool.completed", { callId: "c1", tool: "generate_image", artifactId: "art_2", artifactName: "virphone-logo-2.png", mimeType: "image/png" }),
      ev("files.ready", { artifactId: "art_2", name: "virphone-logo-2.png", message: "virphone-logo-2.png is in Files → Generated (virtual file storage)." }),
    ],
    "completed"
  );
  const card = items.find((i) => i.kind === "attachment") as { name: string; artifactId?: string };
  assert.ok(card);
  assert.equal(card.artifactId, "art_2");
  assert.ok(items.some((i) => i.kind === "status" && /Files → Generated/.test(String((i as { label?: string }).label))));
});

test("artifact.created without artifactId is ignored", () => {
  reset();
  const items = reducePresentation([ev("artifact.created", { name: "virphone-logo.png", kind: "generated" })], "completed");
  assert.equal(items.some((i) => i.kind === "attachment"), false);
});

test("desktop verification and preview events render compact activity", () => {
  reset();
  const items = reducePresentation(
    [
      ev("run.execution", { executionLabel: "Local", executionTargetActual: "local_host" }),
      ev("preview.available", { url: "http://localhost:5173" }),
      ev("desktop.verification.started", {}),
      ev("desktop.verification.passed", {}),
    ],
    "completed"
  );
  const labels = items.filter((i) => i.kind === "status").map((i) => (i as { label: string }).label);
  assert.ok(labels.some((l) => /Execution · Local/.test(l)));
  assert.ok(labels.some((l) => /Browser · Opened/.test(l) && /5173/.test(l)));
  assert.ok(labels.some((l) => /Desktop · Verification passed/.test(l)));
});

test("provider computer-use block and Auto fallback stay truthful in the stream", () => {
  reset();
  const items = reducePresentation(
    [
      ev("desktop.started", { tool: "computer_open_app" }),
      ev("model.capability.blocked", { modelId: "Claude", pinned: false, capability: "computer_use", desktopHealthy: true }),
      ev("model.fallback", { actualModel: "GPT-4o", requestedModel: "auto", extraProviderUsage: true }),
      ev("desktop.screenshot", { sessionId: "desk_1" }),
      ev("desktop.control.changed", { to: "user" }),
      ev("desktop.returned", { sessionId: "desk_1" }),
    ],
    "completed"
  );
  const labels = items.filter((i) => i.kind === "status").map((i) => (i as { label: string }).label);
  assert.ok(labels.some((l) => /Computer use · Starting Desktop/.test(l)));
  assert.ok(labels.some((l) => /Claude cannot use computer control/.test(l)));
  assert.ok(labels.some((l) => /Switched to GPT-4o/.test(l)));
  assert.ok(labels.some((l) => /Desktop · Inspecting app/.test(l)));
  assert.ok(labels.some((l) => /Take Control/.test(l)));
  assert.ok(labels.some((l) => /Returned to ORION/.test(l)));
  assert.ok(!labels.some((l) => /Desktop unavailable/i.test(l)));
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

test("command rows show the result that matters: test counts or the exit code", () => {
  assert.equal(commandSummary("$ npm test\nexit 1\n\n# tests 1\n# pass 0\n# fail 1"), "1 failing");
  assert.equal(commandSummary("> node --test\n# pass 3\n# fail 0"), "3 passed");
  assert.equal(commandSummary("  2 passing (4ms)\n  1 failing"), "1 failing");
  assert.equal(commandSummary("Tests:       18 passed, 18 total"), "18 passed");
  assert.equal(commandSummary("$ ls\nexit 0"), "exit 0");
  assert.equal(commandSummary("hello"), undefined);
});

test("a pause before ORION speaks shows one Thought marker; a quick reply shows none", () => {
  reset();
  const t0 = 1_000_000;
  const at = (type: string, data: Record<string, unknown>, ts: number, i: number) => ({ id: `x${i}`, type, data, timestamp: ts, sequence: i });
  const slow = reducePresentation([
    at("run.started", {}, t0, 1),
    at("message.delta", { content: "Checking." }, t0 + 3000, 2),
    at("message.completed", {}, t0 + 3100, 3),
  ] as any, "completed");
  const marks = slow.filter((i) => i.kind === "status" && (i as any).thought);
  assert.equal(marks.length, 1);
  const quick = reducePresentation([
    at("run.started", {}, t0, 1),
    at("message.delta", { content: "Checking." }, t0 + 200, 2),
    at("message.completed", {}, t0 + 300, 3),
  ] as any, "completed");
  assert.equal(quick.filter((i) => i.kind === "status").length, 0);
});

test("the verifier's verdict shows in the conversation: FAIL with its first finding, then PASS", () => {
  reset();
  const items = reducePresentation(
    [
      ev("verification.completed", { verdict: "FAIL", findings: [{ message: "index.html loads style.css, but style.css does not exist." }, { message: "app.js does not parse" }] }),
      ev("verification.completed", { verdict: "PASS", findings: [] }),
    ],
    "completed"
  );
  const labels = items.filter((i) => i.kind === "status").map((i) => (i as { label: string }).label);
  assert.match(labels[0]!, /^Verification FAIL — index\.html loads style\.css.*\(\+1 more\)/);
  assert.equal(labels[1], "Verified: independent check passed");
});

test("verifier checks are their own labelled rows, and a verifier with no verdict is not shown as ORION's failure", () => {
  reset();
  const items = reducePresentation(
    [
      ev("tool.started", { callId: "verify_1_a", tool: "read_file", args: { path: "hello.txt" }, verifier: true }),
      ev("tool.completed", { callId: "verify_1_a", tool: "read_file", verifier: true }),
      ev("verification.completed", { verdict: "PARTIAL", findings: [{ check: "verifier-unavailable", message: "The verifier model did not return a verdict" }] }),
    ],
    "completed"
  );
  const tool = items.find((i) => i.kind === "tool") as ToolItem | undefined;
  assert.equal(tool?.verifier, true);
  assert.equal(tool?.fileName, "hello.txt");
  const status = items.find((i) => i.kind === "status") as { label: string } | undefined;
  assert.match(String(status?.label), /automatic checks/);
});

test("a withdrawn reply (research first) is not shown as ORION's answer", async () => {
  const { reducePresentation } = await import("./presentationReducer.ts");
  const ev = (type: string, data: Record<string, unknown> = {}, i = 0) => ({ id: `e${i}`, type, timestamp: 1000 + i, data });
  const events = [
    ev("run.started", { instruction: "latest node lts?" }, 0),
    ev("message.delta", { content: "Node.js 20 is the LTS release." }, 1),
    ev("message.retracted", {}, 2),
    ev("message.delta", { content: "Searching the web." }, 3),
    ev("message.completed", {}, 4),
  ];
  const items = reducePresentation(events as any, "running");
  const text = JSON.stringify(items);
  assert.ok(!text.includes("Node.js 20 is the LTS"), text);
  assert.ok(text.includes("Searching the web."), text);
});
