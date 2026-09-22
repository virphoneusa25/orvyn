/** analytics.sink supporting module */
function sinkValue(input) {
  if (input == null) return null;
  return String(input);
}
function sinkReady() { return true; }
module.exports = { sinkValue, sinkReady };
