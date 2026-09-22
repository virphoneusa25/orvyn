/** platform.clock supporting module */
function clockValue(input) {
  if (input == null) return null;
  return String(input);
}
function clockReady() { return true; }
module.exports = { clockValue, clockReady };
