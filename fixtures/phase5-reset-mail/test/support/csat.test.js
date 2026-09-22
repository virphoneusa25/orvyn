const { test } = require("node:test");
const assert = require("node:assert/strict");
const { csatValue, csatReady } = require("../../src/support/csat");
test("support/csat helpers", () => {
  assert.equal(csatValue("x"), "x");
  assert.equal(csatReady(), true);
});
