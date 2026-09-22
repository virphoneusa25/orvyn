/** ops.circuit supporting module */
function circuitValue(input) {
  if (input == null) return null;
  return String(input);
}
function circuitReady() { return true; }
module.exports = { circuitValue, circuitReady };
