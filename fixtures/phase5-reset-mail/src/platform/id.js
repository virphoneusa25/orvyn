/** platform.id supporting module */
function idValue(input) {
  if (input == null) return null;
  return String(input);
}
function idReady() { return true; }
module.exports = { idValue, idReady };
