const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inviteValue, inviteReady } = require("../../src/accounts/invite");
test("accounts/invite helpers", () => {
  assert.equal(inviteValue("x"), "x");
  assert.equal(inviteReady(), true);
});
