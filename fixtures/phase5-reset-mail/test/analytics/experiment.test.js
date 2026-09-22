const { test } = require("node:test");
const assert = require("node:assert/strict");
const { experimentValue, experimentReady } = require("../../src/analytics/experiment");
test("analytics/experiment helpers", () => {
  assert.equal(experimentValue("x"), "x");
  assert.equal(experimentReady(), true);
});
