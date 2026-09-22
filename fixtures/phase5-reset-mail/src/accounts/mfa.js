/** accounts.mfa supporting module */
function mfaValue(input) {
  if (input == null) return null;
  return String(input);
}
function mfaReady() { return true; }
module.exports = { mfaValue, mfaReady };
