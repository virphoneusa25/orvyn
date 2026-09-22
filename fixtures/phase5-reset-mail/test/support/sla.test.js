const { test } = require("node:test");
const assert = require("node:assert/strict");
const { slaValue, slaReady } = require("../../src/support/sla");
test("support/sla helpers", () => {
  assert.equal(slaValue("x"), "x");
  assert.equal(slaReady(), true);
});
