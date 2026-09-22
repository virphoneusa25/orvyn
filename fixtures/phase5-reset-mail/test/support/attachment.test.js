const { test } = require("node:test");
const assert = require("node:assert/strict");
const { attachmentValue, attachmentReady } = require("../../src/support/attachment");
test("support/attachment helpers", () => {
  assert.equal(attachmentValue("x"), "x");
  assert.equal(attachmentReady(), true);
});
