const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewValue, reviewReady } = require("../../src/catalog/review");
test("catalog/review helpers", () => {
  assert.equal(reviewValue("x"), "x");
  assert.equal(reviewReady(), true);
});
