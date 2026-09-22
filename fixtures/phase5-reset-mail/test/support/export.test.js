const { test } = require("node:test");
const assert = require("node:assert/strict");
const { exportValue, exportReady } = require("../../src/support/export");
test("support/export helpers", () => {
  assert.equal(exportValue("x"), "x");
  assert.equal(exportReady(), true);
});
