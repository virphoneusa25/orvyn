const { test } = require("node:test");
const assert = require("node:assert/strict");
const { workerValue, workerReady } = require("../../src/ops/worker");
test("ops/worker helpers", () => {
  assert.equal(workerValue("x"), "x");
  assert.equal(workerReady(), true);
});
