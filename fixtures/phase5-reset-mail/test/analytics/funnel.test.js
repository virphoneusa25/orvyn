const { test } = require("node:test");
const assert = require("node:assert/strict");
const { funnelValue, funnelReady } = require("../../src/analytics/funnel");
test("analytics/funnel helpers", () => {
  assert.equal(funnelValue("x"), "x");
  assert.equal(funnelReady(), true);
});
