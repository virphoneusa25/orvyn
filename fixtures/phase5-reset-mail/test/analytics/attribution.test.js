const { test } = require("node:test");
const assert = require("node:assert/strict");
const { attributionValue, attributionReady } = require("../../src/analytics/attribution");
test("analytics/attribution helpers", () => {
  assert.equal(attributionValue("x"), "x");
  assert.equal(attributionReady(), true);
});
