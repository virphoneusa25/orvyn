import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCompletionGates } from "./completionGates";

test("artifact gate blocks a logo request with no persisted file", () => {
  const r = evaluateCompletionGates({
    instruction: "Generate a virphone logo in png format",
    artifacts: [],
    events: [{ type: "tool.completed", data: { tool: "generate_image" } }],
  });
  assert.equal(r.ok, false);
  assert.equal(r.failedGate, "artifact");
  assert.match(r.retryPrompt, /artifactId/);
  assert.match(r.failMessage, /not complete/);
});

test("artifact gate passes when a ready artifactId exists", () => {
  const r = evaluateCompletionGates({
    instruction: "Generate a virphone logo in png format",
    artifacts: [{ artifactId: "art_1", name: "virphone-logo.png", mimeType: "image/png" }],
    events: [{ type: "artifact.created", data: { artifactId: "art_1" } }],
  });
  assert.equal(r.ok, true);
});

test("a workspace file create completes on write_file and read_file, not an artifact", () => {
  const instruction = "Create a file named hello.txt containing exactly hello world, read the file back, and tell me what it contains.";
  const blocked = evaluateCompletionGates({ instruction, artifacts: [], events: [] });
  assert.equal(blocked.ok, false);
  assert.match(blocked.retryPrompt, /write_file/);
  assert.match(blocked.retryPrompt, /Do not use generate_image/);

  const wrote = evaluateCompletionGates({
    instruction,
    artifacts: [],
    events: [{ type: "tool.completed", data: { tool: "write_file" } }, { type: "file.created", data: { path: "hello.txt" } }],
  });
  assert.equal(wrote.ok, false);
  assert.match(wrote.retryPrompt, /read_file/);

  const done = evaluateCompletionGates({
    instruction,
    artifacts: [],
    events: [
      { type: "tool.completed", data: { tool: "write_file" } },
      { type: "file.created", data: { path: "hello.txt" } },
      { type: "tool.completed", data: { tool: "read_file" } },
      { type: "file.read", data: { path: "hello.txt" } },
    ],
  });
  assert.equal(done.ok, true);
});

test("code gate requires tests when the user asked to verify", () => {
  const blocked = evaluateCompletionGates({
    instruction: "Fix the failing tests in src/calc.ts",
    artifacts: [],
    events: [{ type: "file.edit", data: { path: "src/calc.ts" } }],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failedGate, "code");

  const passed = evaluateCompletionGates({
    instruction: "Fix the failing tests in src/calc.ts",
    artifacts: [],
    events: [
      { type: "file.edit", data: { path: "src/calc.ts" } },
      { type: "tool.completed", data: { tool: "run_tests" } },
    ],
  });
  assert.equal(passed.ok, true);
});

test("visual gate requires a screenshot for UI work", () => {
  const blocked = evaluateCompletionGates({
    instruction: "The dashboard layout overflows. Fix the visible CSS issue.",
    artifacts: [],
    events: [{ type: "file.edit", data: { path: "styles.css" } }],
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failedGate, "visual");

  const passed = evaluateCompletionGates({
    instruction: "The dashboard layout overflows. Fix the visible CSS issue.",
    artifacts: [],
    events: [
      { type: "file.edit", data: { path: "styles.css" } },
      { type: "desktop.verification.passed", data: {} },
    ],
  });
  assert.equal(passed.ok, true);
});

test("a passing re-run after a failed test run completes the code gate", () => {
  const events = [
    { type: "tool.completed", data: { tool: "edit_file" } },
    { type: "tool.failed", data: { tool: "run_tests", error: "No test runner found" } },
    { type: "tool.completed", data: { tool: "edit_file" } },
    { type: "tool.completed", data: { tool: "run_tests" } },
  ] as any;
  const ok = evaluateCompletionGates({ instruction: "Fix the failing test in src/app.js", artifacts: [], events, category: "code" } as any);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const stillFailing = evaluateCompletionGates({ instruction: "Fix the failing test in src/app.js", artifacts: [], events: [...events, { type: "tool.failed", data: { tool: "run_tests" } }], category: "code" } as any);
  assert.equal(stillFailing.ok, false);
});
