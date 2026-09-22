const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ticketValue, ticketReady } = require("../../src/support/ticket");
test("support/ticket helpers", () => {
  assert.equal(ticketValue("x"), "x");
  assert.equal(ticketReady(), true);
});
