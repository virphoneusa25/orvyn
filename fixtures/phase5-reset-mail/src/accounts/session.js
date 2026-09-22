/** accounts.session supporting module */
function sessionValue(input) {
  if (input == null) return null;
  return String(input);
}
function sessionReady() { return true; }
module.exports = { sessionValue, sessionReady };
