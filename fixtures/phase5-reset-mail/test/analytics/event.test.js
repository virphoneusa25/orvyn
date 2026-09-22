const { test } = require("node:test");
const assert = require("node:assert/strict");
const { eventValue, eventReady } = require("../../src/analytics/event");
test("analytics/event helpers", () => {
  assert.equal(eventValue("x"), "x");
  assert.equal(eventReady(), true);
});
