const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loggerValue, loggerReady } = require("../../src/ops/logger");
test("ops/logger helpers", () => {
  assert.equal(loggerValue("x"), "x");
  assert.equal(loggerReady(), true);
});
