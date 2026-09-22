const { test } = require("node:test");
const assert = require("node:assert/strict");
const { circuitValue, circuitReady } = require("../../src/ops/circuit");
test("ops/circuit helpers", () => {
  assert.equal(circuitValue("x"), "x");
  assert.equal(circuitReady(), true);
});
