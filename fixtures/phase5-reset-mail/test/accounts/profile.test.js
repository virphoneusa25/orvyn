const { test } = require("node:test");
const assert = require("node:assert/strict");
const { profileValue, profileReady } = require("../../src/accounts/profile");
test("accounts/profile helpers", () => {
  assert.equal(profileValue("x"), "x");
  assert.equal(profileReady(), true);
});
