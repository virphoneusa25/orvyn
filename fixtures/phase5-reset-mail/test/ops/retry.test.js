const { test } = require("node:test");
const assert = require("node:assert/strict");
const { retryValue, retryReady } = require("../../src/ops/retry");
test("ops/retry helpers", () => {
  assert.equal(retryValue("x"), "x");
  assert.equal(retryReady(), true);
});
