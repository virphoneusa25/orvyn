const { test } = require("node:test");
const assert = require("node:assert/strict");
const { idValue, idReady } = require("../../src/platform/id");
test("platform/id helpers", () => {
  assert.equal(idValue("x"), "x");
  assert.equal(idReady(), true);
});
