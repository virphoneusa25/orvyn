/** ops.lock supporting module */
function lockValue(input) {
  if (input == null) return null;
  return String(input);
}
function lockReady() { return true; }
module.exports = { lockValue, lockReady };
