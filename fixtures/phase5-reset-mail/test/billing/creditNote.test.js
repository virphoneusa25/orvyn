const { test } = require("node:test");
const assert = require("node:assert/strict");
const { creditNoteValue, creditNoteReady } = require("../../src/billing/creditNote");
test("billing/creditNote helpers", () => {
  assert.equal(creditNoteValue("x"), "x");
  assert.equal(creditNoteReady(), true);
});
