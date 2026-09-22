const { test } = require("node:test");
const assert = require("node:assert/strict");
const { noteValue, noteReady } = require("../../src/support/note");
test("support/note helpers", () => {
  assert.equal(noteValue("x"), "x");
  assert.equal(noteReady(), true);
});
