/** accounts.device supporting module */
function deviceValue(input) {
  if (input == null) return null;
  return String(input);
}
function deviceReady() { return true; }
module.exports = { deviceValue, deviceReady };
