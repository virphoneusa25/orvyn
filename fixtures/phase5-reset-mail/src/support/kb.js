/** support.kb supporting module */
function kbValue(input) {
  if (input == null) return null;
  return String(input);
}
function kbReady() { return true; }
module.exports = { kbValue, kbReady };
