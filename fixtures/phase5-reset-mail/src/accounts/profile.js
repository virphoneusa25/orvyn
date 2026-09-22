/** accounts.profile supporting module */
function profileValue(input) {
  if (input == null) return null;
  return String(input);
}
function profileReady() { return true; }
module.exports = { profileValue, profileReady };
