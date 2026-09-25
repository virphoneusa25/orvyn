import { test } from "node:test";
import assert from "node:assert/strict";
import { canEnterPhase, decideCompletion } from "./agentRunState";

test("a run cannot leave a terminal phase, and work cannot skip backward", () => {
  assert.equal(canEnterPhase("preflight", "introducing"), true);
  assert.equal(canEnterPhase("acting", "observing"), true);
  assert.equal(canEnterPhase("observing", "repairing"), true);
  assert.equal(canEnterPhase("observing", "acting"), true);
  assert.equal(canEnterPhase("verifying", "preflight"), false);
  assert.equal(canEnterPhase("completed", "acting"), false);
  assert.equal(canEnterPhase("acting", "failed"), true);
});

test("a website is not complete until the browser check passes", () => {
  const instruction = "Build a polished one-page SaaS website";
  const files = [{ type: "file.created", data: { path: "index.html" } }];
  assert.equal(decideCompletion({ instruction, events: files }), "continue");
  assert.equal(decideCompletion({
    instruction,
    events: [...files, { type: "preview.available", data: { url: "http://localhost:8080/" } }],
  }), "continue");
  assert.equal(decideCompletion({
    instruction,
    events: [...files, { type: "preview.available", data: { url: "https://preview.example/s/1" } }],
  }), "continue");
  assert.equal(decideCompletion({
    instruction,
    events: [
      ...files,
      { type: "preview.available", data: { url: "https://preview.example/s/1" } },
      { type: "browser.verification.passed", data: {} },
    ],
  }), "continue", "an HTTP fetch of the preview is not a browser check");
  assert.equal(decideCompletion({
    instruction,
    events: [
      ...files,
      { type: "preview.available", data: { url: "https://preview.example/s/1" } },
      { type: "verification.completed", data: { verdict: "PASS", checks: [{ name: "browser", status: "pass" }] } },
    ],
  }), "completed");
  assert.equal(decideCompletion({
    instruction,
    events: [
      ...files,
      { type: "preview.available", data: { url: "https://preview.example/s/1" } },
      { type: "verification.completed", data: { verdict: "PASS", checks: [{ name: "browser", status: "pass" }] } },
      { type: "verification.completed", data: { verdict: "FAIL", checks: [{ name: "browser", status: "fail" }] } },
    ],
  }), "continue", "only the latest verification counts");
  assert.equal(decideCompletion({ instruction: "Create hello.txt", events: [] }), "completed");
});
