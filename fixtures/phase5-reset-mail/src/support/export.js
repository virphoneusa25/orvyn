/** support.export supporting module */
function exportValue(input) {
  if (input == null) return null;
  return String(input);
}
function exportReady() { return true; }
module.exports = { exportValue, exportReady };
