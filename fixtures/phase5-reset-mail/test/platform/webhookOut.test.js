const { test } = require("node:test");
const assert = require("node:assert/strict");
const { webhookOutValue, webhookOutReady } = require("../../src/platform/webhookOut");
test("platform/webhookOut helpers", () => {
  assert.equal(webhookOutValue("x"), "x");
  assert.equal(webhookOutReady(), true);
});
