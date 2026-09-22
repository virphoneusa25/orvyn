const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cacheValue, cacheReady } = require("../../src/ops/cache");
test("ops/cache helpers", () => {
  assert.equal(cacheValue("x"), "x");
  assert.equal(cacheReady(), true);
});
