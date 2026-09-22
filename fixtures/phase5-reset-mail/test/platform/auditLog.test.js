const { test } = require("node:test");
const assert = require("node:assert/strict");
const { auditLogValue, auditLogReady } = require("../../src/platform/auditLog");
test("platform/auditLog helpers", () => {
  assert.equal(auditLogValue("x"), "x");
  assert.equal(auditLogReady(), true);
});
