const { test } = require("node:test");
const assert = require("node:assert/strict");
const { webhookValue, webhookReady } = require("../../src/billing/webhook");
test("billing/webhook helpers", () => {
  assert.equal(webhookValue("x"), "x");
  assert.equal(webhookReady(), true);
});
