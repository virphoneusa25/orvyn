const { test } = require("node:test");
const assert = require("node:assert/strict");
const { passwordValue, passwordReady } = require("../../src/accounts/password");
test("accounts/password helpers", () => {
  assert.equal(passwordValue("x"), "x");
  assert.equal(passwordReady(), true);
});
