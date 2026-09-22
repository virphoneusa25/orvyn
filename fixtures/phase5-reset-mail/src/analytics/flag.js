/** analytics.flag supporting module */
function flagValue(input) {
  if (input == null) return null;
  return String(input);
}
function flagReady() { return true; }
module.exports = { flagValue, flagReady };
