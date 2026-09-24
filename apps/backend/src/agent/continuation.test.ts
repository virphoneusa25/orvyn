import { test } from "node:test";
import assert from "node:assert/strict";
import { announcesPendingWork } from "./continuation";

test("a reply that promises the next step is not a final answer", () => {
  for (const text of [
    "hello.txt is created. Next, I'll read it back to confirm what it contains.",
    "The file is written. Now let me run the tests.",
    "I've updated app.js. Let me run it again to check the new output.",
    "Install finished. I will now start the dev server.",
    "Tests failed on line 12. I'm going to fix the assertion and re-run.",
  ]) {
    assert.equal(announcesPendingWork(text), true, text);
  }
});

test("outcome reports, questions and empty replies are real stops", () => {
  for (const text of [
    'Done. I created hello.txt and read it back — it contains exactly: "Hello World".',
    "The final output is: Goodbye, world.",
    "Should I also deploy it to staging?",
    "I need you to connect a server before I can check disk space.",
    "Let me know if you want a different greeting.",
    "",
    "I'll create hello.txt, then read it back.\n\nDone — hello.txt contains Hello World.",
  ]) {
    assert.equal(announcesPendingWork(text), false, text);
  }
});
