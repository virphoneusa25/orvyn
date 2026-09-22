const { test } = require("node:test");
const assert = require("node:assert/strict");
const { metricsValue, metricsReady } = require("../../src/ops/metrics");
test("ops/metrics helpers", () => {
  assert.equal(metricsValue("x"), "x");
  assert.equal(metricsReady(), true);
});
