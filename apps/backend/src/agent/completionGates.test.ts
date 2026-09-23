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
