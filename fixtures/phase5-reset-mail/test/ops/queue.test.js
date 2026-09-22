const { test } = require("node:test");
const assert = require("node:assert/strict");
const { queueValue, queueReady } = require("../../src/ops/queue");
test("ops/queue helpers", () => {
  assert.equal(queueValue("x"), "x");
  assert.equal(queueReady(), true);
});
