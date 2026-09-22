const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hashValue, hashReady } = require("../../src/platform/hash");
test("platform/hash helpers", () => {
  assert.equal(hashValue("x"), "x");
  assert.equal(hashReady(), true);
});
