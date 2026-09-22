/** platform.hash supporting module */
function hashValue(input) {
  if (input == null) return null;
  return String(input);
}
function hashReady() { return true; }
module.exports = { hashValue, hashReady };
