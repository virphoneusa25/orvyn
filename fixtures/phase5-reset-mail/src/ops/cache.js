/** ops.cache supporting module */
function cacheValue(input) {
  if (input == null) return null;
  return String(input);
}
function cacheReady() { return true; }
module.exports = { cacheValue, cacheReady };
