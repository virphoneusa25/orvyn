const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mediaValue, mediaReady } = require("../../src/catalog/media");
test("catalog/media helpers", () => {
  assert.equal(mediaValue("x"), "x");
  assert.equal(mediaReady(), true);
});
