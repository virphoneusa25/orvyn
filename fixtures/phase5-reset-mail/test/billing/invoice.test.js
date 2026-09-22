const { test } = require("node:test");
const assert = require("node:assert/strict");
const { invoiceValue, invoiceReady } = require("../../src/billing/invoice");
test("billing/invoice helpers", () => {
  assert.equal(invoiceValue("x"), "x");
  assert.equal(invoiceReady(), true);
});
