const { test } = require("node:test");
const assert = require("node:assert/strict");
const { couponValue, couponReady } = require("../../src/billing/coupon");
test("billing/coupon helpers", () => {
  assert.equal(couponValue("x"), "x");
  assert.equal(couponReady(), true);
});
