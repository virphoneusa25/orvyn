const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sinkValue, sinkReady } = require("../../src/analytics/sink");
test("analytics/sink helpers", () => {
  assert.equal(sinkValue("x"), "x");
  assert.equal(sinkReady(), true);
});
