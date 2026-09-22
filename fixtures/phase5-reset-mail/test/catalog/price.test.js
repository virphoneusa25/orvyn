const { test } = require("node:test");
const assert = require("node:assert/strict");
const { priceValue, priceReady } = require("../../src/catalog/price");
test("catalog/price helpers", () => {
  assert.equal(priceValue("x"), "x");
  assert.equal(priceReady(), true);
});
