const { test } = require("node:test");
const assert = require("node:assert/strict");
const { preferenceValue, preferenceReady } = require("../../src/accounts/preference");
test("accounts/preference helpers", () => {
  assert.equal(preferenceValue("x"), "x");
  assert.equal(preferenceReady(), true);
});
