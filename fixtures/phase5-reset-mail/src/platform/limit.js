/** platform.limit supporting module */
function limitValue(input) {
  if (input == null) return null;
  return String(input);
}
function limitReady() { return true; }
module.exports = { limitValue, limitReady };
