const { test } = require("node:test");
const assert = require("node:assert/strict");
const { facetValue, facetReady } = require("../../src/catalog/facet");
test("catalog/facet helpers", () => {
  assert.equal(facetValue("x"), "x");
  assert.equal(facetReady(), true);
});
