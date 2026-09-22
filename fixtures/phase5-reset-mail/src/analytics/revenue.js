/** analytics.revenue supporting module */
function revenueValue(input) {
  if (input == null) return null;
  return String(input);
}
function revenueReady() { return true; }
module.exports = { revenueValue, revenueReady };
