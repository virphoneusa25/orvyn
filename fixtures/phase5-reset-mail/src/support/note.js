/** support.note supporting module */
function noteValue(input) {
  if (input == null) return null;
  return String(input);
}
function noteReady() { return true; }
module.exports = { noteValue, noteReady };
