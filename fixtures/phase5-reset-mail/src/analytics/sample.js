/** analytics.sample supporting module */
function sampleValue(input) {
  if (input == null) return null;
  return String(input);
}
function sampleReady() { return true; }
module.exports = { sampleValue, sampleReady };
