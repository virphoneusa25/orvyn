const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sessionValue, sessionReady } = require("../../src/accounts/session");
test("accounts/session helpers", () => {
  assert.equal(sessionValue("x"), "x");
  assert.equal(sessionReady(), true);
});
