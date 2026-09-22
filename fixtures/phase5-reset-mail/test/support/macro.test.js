const { test } = require("node:test");
const assert = require("node:assert/strict");
const { macroValue, macroReady } = require("../../src/support/macro");
test("support/macro helpers", () => {
  assert.equal(macroValue("x"), "x");
  assert.equal(macroReady(), true);
});
