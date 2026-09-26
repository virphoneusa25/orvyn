import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepQuestion } from "./advisorStyle";

test("thinking-heavy questions are recognised; quick ones and code tasks are not", () => {
  for (const p of [
    "What should we call our foundation model family for Kernel AI?",
    "Give me a roadmap for training KXM before we spend on a 30B run",
    "Should I use Kamailio or OpenSIPS for the SIP edge?",
    "Compare Postgres vs MongoDB for our billing data",
    "How would you architect the public API for Kernel AI?",
    "Review our pricing strategy for resellers",
  ]) assert.equal(isDeepQuestion(p), true, p);
  for (const p of ["What is 2+2?", "hi", "Create hello.txt", "Fix the failing test in src/app.js", "What time is it in Tokyo?"]) {
    assert.equal(isDeepQuestion(p), false, p);
  }
  assert.equal(isDeepQuestion("What is 2+2?", "deep"), true, "the user asked for deep reasoning");
});
