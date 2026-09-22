const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inventoryValue, inventoryReady } = require("../../src/catalog/inventory");
test("catalog/inventory helpers", () => {
  assert.equal(inventoryValue("x"), "x");
  assert.equal(inventoryReady(), true);
});
