/** ops.logger supporting module */
function loggerValue(input) {
  if (input == null) return null;
  return String(input);
}
function loggerReady() { return true; }
module.exports = { loggerValue, loggerReady };
