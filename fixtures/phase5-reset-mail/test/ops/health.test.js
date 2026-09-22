const { test } = require("node:test");
const assert = require("node:assert/strict");
const { healthValue, healthReady } = require("../../src/ops/health");
test("ops/health helpers", () => {
  assert.equal(healthValue("x"), "x");
  assert.equal(healthReady(), true);
});
