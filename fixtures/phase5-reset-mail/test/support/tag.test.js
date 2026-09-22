const { test } = require("node:test");
const assert = require("node:assert/strict");
const { tagValue, tagReady } = require("../../src/support/tag");
test("support/tag helpers", () => {
  assert.equal(tagValue("x"), "x");
  assert.equal(tagReady(), true);
});
