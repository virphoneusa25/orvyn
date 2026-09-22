const { test } = require("node:test");
const assert = require("node:assert/strict");
const { usageValue, usageReady } = require("../../src/billing/usage");
test("billing/usage helpers", () => {
  assert.equal(usageValue("x"), "x");
  assert.equal(usageReady(), true);
});
