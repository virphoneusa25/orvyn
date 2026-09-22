/** accounts.password supporting module */
function passwordValue(input) {
  if (input == null) return null;
  return String(input);
}
function passwordReady() { return true; }
module.exports = { passwordValue, passwordReady };
