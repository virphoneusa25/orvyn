const { test } = require("node:test");
const assert = require("node:assert/strict");
const { skuValue, skuReady } = require("../../src/catalog/sku");
test("catalog/sku helpers", () => {
  assert.equal(skuValue("x"), "x");
  assert.equal(skuReady(), true);
});
