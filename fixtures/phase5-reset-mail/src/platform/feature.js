/** platform.feature supporting module */
function featureValue(input) {
  if (input == null) return null;
  return String(input);
}
function featureReady() { return true; }
module.exports = { featureValue, featureReady };
