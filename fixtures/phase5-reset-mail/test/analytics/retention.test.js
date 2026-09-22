const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retentionValue, retentionReady } = require("../../src/analytics/retention");
test("analytics/retention helpers", () => {
  assert.equal(retentionValue("x"), "x");
  assert.equal(retentionReady(), true);
});
