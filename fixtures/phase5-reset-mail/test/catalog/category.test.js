const { test } = require("node:test");
const assert = require("node:assert/strict");
const { categoryValue, categoryReady } = require("../../src/catalog/category");
test("catalog/category helpers", () => {
  assert.equal(categoryValue("x"), "x");
  assert.equal(categoryReady(), true);
});
