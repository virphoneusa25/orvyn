/** accounts.invite supporting module */
function inviteValue(input) {
  if (input == null) return null;
  return String(input);
}
function inviteReady() { return true; }
module.exports = { inviteValue, inviteReady };
