const { test } = require("node:test");
const assert = require("node:assert/strict");
const { limitValue, limitReady } = require("../../src/platform/limit");
test("platform/limit helpers", () => {
  assert.equal(limitValue("x"), "x");
  assert.equal(limitReady(), true);
});
