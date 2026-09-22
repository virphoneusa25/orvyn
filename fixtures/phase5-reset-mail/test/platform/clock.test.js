const { test } = require("node:test");
const assert = require("node:assert/strict");
const { clockValue, clockReady } = require("../../src/platform/clock");
test("platform/clock helpers", () => {
  assert.equal(clockValue("x"), "x");
  assert.equal(clockReady(), true);
});
