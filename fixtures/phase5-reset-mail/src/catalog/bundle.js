/** catalog.bundle supporting module */
function bundleValue(input) {
  if (input == null) return null;
  return String(input);
}
function bundleReady() { return true; }
module.exports = { bundleValue, bundleReady };
