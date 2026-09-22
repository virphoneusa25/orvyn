const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ledgerValue, ledgerReady } = require("../../src/billing/ledger");
test("billing/ledger helpers", () => {
  assert.equal(ledgerValue("x"), "x");
  assert.equal(ledgerReady(), true);
});
