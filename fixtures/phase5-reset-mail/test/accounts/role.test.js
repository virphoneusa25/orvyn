const { test } = require("node:test");
const assert = require("node:assert/strict");
const { roleValue, roleReady } = require("../../src/accounts/role");
test("accounts/role helpers", () => {
  assert.equal(roleValue("x"), "x");
  assert.equal(roleReady(), true);
});
