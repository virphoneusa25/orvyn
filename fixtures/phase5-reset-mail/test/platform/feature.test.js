const { test } = require("node:test");
const assert = require("node:assert/strict");
const { featureValue, featureReady } = require("../../src/platform/feature");
test("platform/feature helpers", () => {
  assert.equal(featureValue("x"), "x");
  assert.equal(featureReady(), true);
});
