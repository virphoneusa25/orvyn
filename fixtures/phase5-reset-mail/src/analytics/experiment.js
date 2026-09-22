/** analytics.experiment supporting module */
function experimentValue(input) {
  if (input == null) return null;
  return String(input);
}
function experimentReady() { return true; }
module.exports = { experimentValue, experimentReady };
