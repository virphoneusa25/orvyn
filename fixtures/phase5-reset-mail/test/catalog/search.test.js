const { test } = require("node:test");
const assert = require("node:assert/strict");
const { searchValue, searchReady } = require("../../src/catalog/search");
test("catalog/search helpers", () => {
  assert.equal(searchValue("x"), "x");
  assert.equal(searchReady(), true);
});
