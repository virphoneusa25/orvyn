const { test } = require("node:test");
const assert = require("node:assert/strict");
const { oauthValue, oauthReady } = require("../../src/accounts/oauth");
test("accounts/oauth helpers", () => {
  assert.equal(oauthValue("x"), "x");
  assert.equal(oauthReady(), true);
});
