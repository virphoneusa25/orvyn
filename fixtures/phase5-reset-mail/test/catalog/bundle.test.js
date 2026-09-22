const { test } = require("node:test");
const assert = require("node:assert/strict");
const { bundleValue, bundleReady } = require("../../src/catalog/bundle");
test("catalog/bundle helpers", () => {
  assert.equal(bundleValue("x"), "x");
  assert.equal(bundleReady(), true);
});
