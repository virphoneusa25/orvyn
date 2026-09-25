import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateCompletionGates, asksForVerification } from "./completionGates";

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

test("the word test alone does not demand a test run", () => {
  for (const p of ["Create a file with the word test in it", "Put test in it", "Create a test file with hello"]) {
    assert.equal(asksForVerification(p), false, p);
  }
  for (const p of ["Fix the bug and run the tests", "Write tests for the parser", "make sure the tests pass", "fix the failing test", "run npm test", "typecheck the project", "add unit tests"]) {
    assert.equal(asksForVerification(p), true, p);
  }
});

test("npm test run through the terminal counts as the test run", () => {
  const instruction = "Fix the failing test in src/app.js";
  const failedOnly = [
    { type: "tool.completed", data: { tool: "edit_file", callId: "c1" } },
    { type: "tool.input", data: { callId: "c2", input: { command: "npm test" } } },
    { type: "tool.failed", data: { tool: "terminal", callId: "c2", error: "exit 1" } },
  ] as any;
  assert.equal(evaluateCompletionGates({ instruction, artifacts: [], events: failedOnly, category: "code" } as any).ok, false);
  const repaired = [
    ...failedOnly,
    { type: "tool.completed", data: { tool: "edit_file", callId: "c3" } },
    { type: "tool.input", data: { callId: "c4", input: { command: "npm test" } } },
    { type: "tool.completed", data: { tool: "terminal", callId: "c4" } },
  ] as any;
  assert.equal(evaluateCompletionGates({ instruction, artifacts: [], events: repaired, category: "code" } as any).ok, true);
  const unrelated = [
    { type: "tool.completed", data: { tool: "edit_file", callId: "c1" } },
    { type: "tool.input", data: { callId: "c2", input: { command: "ls" } } },
    { type: "tool.completed", data: { tool: "terminal", callId: "c2" } },
  ] as any;
  assert.equal(evaluateCompletionGates({ instruction, artifacts: [], events: unrelated, category: "code" } as any).ok, false);
});

test("a localhost preview counts on the desktop's local engine, not on ORVYN Cloud", () => {
  const events = [
    { type: "file.created", data: { path: "index.html" } },
    { type: "preview.available", data: { url: "http://localhost:4570/api/v1/sites/x/" } },
    { type: "browser.verification.passed", data: { url: "http://localhost:4570/api/v1/sites/x/" } },
  ] as any;
  const input = { instruction: "Build a small landing page", artifacts: [], events };
  const cloud = evaluateCompletionGates(input as any);
  assert.equal(cloud.ok, false);
  assert.match(cloud.reasons.join(" "), /no reachable preview/);
  const local = evaluateCompletionGates({ ...input, localEngine: true } as any);
  assert.ok(!/no reachable preview/.test(local.reasons.join(" ")), local.reasons.join(" "));
});
