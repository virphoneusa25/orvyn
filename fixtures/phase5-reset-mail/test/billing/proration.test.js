const { test } = require("node:test");
const assert = require("node:assert/strict");
const { prorationValue, prorationReady } = require("../../src/billing/proration");
test("billing/proration helpers", () => {
  assert.equal(prorationValue("x"), "x");
  assert.equal(prorationReady(), true);
});
