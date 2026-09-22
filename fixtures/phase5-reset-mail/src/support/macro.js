/** support.macro supporting module */
function macroValue(input) {
  if (input == null) return null;
  return String(input);
}
function macroReady() { return true; }
module.exports = { macroValue, macroReady };
