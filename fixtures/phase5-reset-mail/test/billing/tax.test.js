const { test } = require("node:test");
const assert = require("node:assert/strict");
const { taxValue, taxReady } = require("../../src/billing/tax");
test("billing/tax helpers", () => {
  assert.equal(taxValue("x"), "x");
  assert.equal(taxReady(), true);
});
