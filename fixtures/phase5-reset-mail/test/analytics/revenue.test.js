const { test } = require("node:test");
const assert = require("node:assert/strict");
const { revenueValue, revenueReady } = require("../../src/analytics/revenue");
test("analytics/revenue helpers", () => {
  assert.equal(revenueValue("x"), "x");
  assert.equal(revenueReady(), true);
});
