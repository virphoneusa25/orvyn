const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sampleValue, sampleReady } = require("../../src/analytics/sample");
test("analytics/sample helpers", () => {
  assert.equal(sampleValue("x"), "x");
  assert.equal(sampleReady(), true);
});
