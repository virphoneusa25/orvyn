/** analytics.funnel supporting module */
function funnelValue(input) {
  if (input == null) return null;
  return String(input);
}
function funnelReady() { return true; }
module.exports = { funnelValue, funnelReady };
