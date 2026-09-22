const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lockValue, lockReady } = require("../../src/ops/lock");
test("ops/lock helpers", () => {
  assert.equal(lockValue("x"), "x");
  assert.equal(lockReady(), true);
});
