const { test } = require("node:test");
const assert = require("node:assert/strict");
const { productValue, productReady } = require("../../src/catalog/product");
test("catalog/product helpers", () => {
  assert.equal(productValue("x"), "x");
  assert.equal(productReady(), true);
});
