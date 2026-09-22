const { test } = require("node:test");
const assert = require("node:assert/strict");
const { flagValue, flagReady } = require("../../src/analytics/flag");
test("analytics/flag helpers", () => {
  assert.equal(flagValue("x"), "x");
  assert.equal(flagReady(), true);
});
