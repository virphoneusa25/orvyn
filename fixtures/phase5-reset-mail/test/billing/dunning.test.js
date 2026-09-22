const { test } = require("node:test");
const assert = require("node:assert/strict");
const { dunningValue, dunningReady } = require("../../src/billing/dunning");
test("billing/dunning helpers", () => {
  assert.equal(dunningValue("x"), "x");
  assert.equal(dunningReady(), true);
});
