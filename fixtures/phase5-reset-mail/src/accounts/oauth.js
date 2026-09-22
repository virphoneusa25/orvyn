/** accounts.oauth supporting module */
function oauthValue(input) {
  if (input == null) return null;
  return String(input);
}
function oauthReady() { return true; }
module.exports = { oauthValue, oauthReady };
