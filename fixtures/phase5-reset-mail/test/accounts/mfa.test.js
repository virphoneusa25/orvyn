const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mfaValue, mfaReady } = require("../../src/accounts/mfa");
test("accounts/mfa helpers", () => {
  assert.equal(mfaValue("x"), "x");
  assert.equal(mfaReady(), true);
});
