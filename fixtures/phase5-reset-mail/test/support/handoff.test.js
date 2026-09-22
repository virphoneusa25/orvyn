const { test } = require("node:test");
const assert = require("node:assert/strict");
const { handoffValue, handoffReady } = require("../../src/support/handoff");
test("support/handoff helpers", () => {
  assert.equal(handoffValue("x"), "x");
  assert.equal(handoffReady(), true);
});
