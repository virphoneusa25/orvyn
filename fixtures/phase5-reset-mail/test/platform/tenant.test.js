const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tenantValue, tenantReady } = require("../../src/platform/tenant");
test("platform/tenant helpers", () => {
  assert.equal(tenantValue("x"), "x");
  assert.equal(tenantReady(), true);
});
