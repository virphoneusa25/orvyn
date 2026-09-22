const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditValue, auditReady } = require("../../src/accounts/audit");
test("accounts/audit helpers", () => {
  assert.equal(auditValue("x"), "x");
  assert.equal(auditReady(), true);
});
