/** accounts.preference supporting module */
function preferenceValue(input) {
  if (input == null) return null;
  return String(input);
}
function preferenceReady() { return true; }
module.exports = { preferenceValue, preferenceReady };
