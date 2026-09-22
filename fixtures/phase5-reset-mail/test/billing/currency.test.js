const { test } = require("node:test");
const assert = require("node:assert/strict");
const { currencyValue, currencyReady } = require("../../src/billing/currency");
test("billing/currency helpers", () => {
  assert.equal(currencyValue("x"), "x");
  assert.equal(currencyReady(), true);
});
