const { test } = require("node:test");
const assert = require("node:assert/strict");
const { schedulerValue, schedulerReady } = require("../../src/ops/scheduler");
test("ops/scheduler helpers", () => {
  assert.equal(schedulerValue("x"), "x");
  assert.equal(schedulerReady(), true);
});
