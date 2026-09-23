import { test } from "node:test";
import assert from "node:assert/strict";
import { groundSuccessClaims } from "./claimValidator";

test("a test-pass sentence is removed when no test event exists", () => {
  const result = groundSuccessClaims("I looked around. All tests passed.", []);
  assert.equal(result.blocked, true);
  assert.match(result.text, /looked around/);
  assert.doesNotMatch(result.text, /tests passed/i);
});

test("a test-pass sentence stays when a test command succeeded", () => {
  const result = groundSuccessClaims("All tests passed.", [
    { type: "test.completed", data: { ok: true } },
  ]);
  assert.equal(result.blocked, false);
  assert.match(result.text, /tests passed/i);
});

test("visual and fix claims require their events", () => {
  const visual = groundSuccessClaims("I verified the UI.", []);
  assert.equal(visual.blocked, true);
  assert.doesNotMatch(visual.text, /verified the UI/i);
  const kept = groundSuccessClaims("I verified the UI.", [
    { type: "browser.verification.passed" },
  ]);
  assert.equal(kept.blocked, false);
  const fix = groundSuccessClaims("I fixed the bug.", []);
  assert.equal(fix.blocked, true);
  const edited = groundSuccessClaims("I fixed the bug.", [{ type: "file.edit", data: { path: "src/App.tsx" } }]);
  assert.equal(edited.blocked, false);
});
