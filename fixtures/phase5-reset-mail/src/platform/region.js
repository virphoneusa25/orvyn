/** platform.region supporting module */
function regionValue(input) {
  if (input == null) return null;
  return String(input);
}
function regionReady() { return true; }
module.exports = { regionValue, regionReady };
