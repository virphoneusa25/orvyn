const { test } = require("node:test");
const assert = require("node:assert/strict");
const { deviceValue, deviceReady } = require("../../src/accounts/device");
test("accounts/device helpers", () => {
  assert.equal(deviceValue("x"), "x");
  assert.equal(deviceReady(), true);
});
