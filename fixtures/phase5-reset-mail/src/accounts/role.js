/** accounts.role supporting module */
function roleValue(input) {
  if (input == null) return null;
  return String(input);
}
function roleReady() { return true; }
module.exports = { roleValue, roleReady };
