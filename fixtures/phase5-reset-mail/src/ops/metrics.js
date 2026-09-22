/** ops.metrics supporting module */
function metricsValue(input) {
  if (input == null) return null;
  return String(input);
}
function metricsReady() { return true; }
module.exports = { metricsValue, metricsReady };
