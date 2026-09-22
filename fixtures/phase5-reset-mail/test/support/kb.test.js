const { test } = require("node:test");
const assert = require("node:assert/strict");
const { kbValue, kbReady } = require("../../src/support/kb");
test("support/kb helpers", () => {
  assert.equal(kbValue("x"), "x");
  assert.equal(kbReady(), true);
});
