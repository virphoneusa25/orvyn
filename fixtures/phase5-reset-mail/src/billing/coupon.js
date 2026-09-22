/** billing.coupon supporting module */
function couponValue(input) {
  if (input == null) return null;
  return String(input);
}
function couponReady() { return true; }
module.exports = { couponValue, couponReady };
