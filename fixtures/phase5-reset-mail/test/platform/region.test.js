const { test } = require("node:test");
const assert = require("node:assert/strict");
const { regionValue, regionReady } = require("../../src/platform/region");
test("platform/region helpers", () => {
  assert.equal(regionValue("x"), "x");
  assert.equal(regionReady(), true);
});
