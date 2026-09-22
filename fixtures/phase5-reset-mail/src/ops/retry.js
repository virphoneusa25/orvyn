/** ops.retry supporting module */
function retryValue(input) {
  if (input == null) return null;
  return String(input);
}
function retryReady() { return true; }
module.exports = { retryValue, retryReady };
