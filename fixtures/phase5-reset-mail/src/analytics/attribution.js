/** analytics.attribution supporting module */
function attributionValue(input) {
  if (input == null) return null;
  return String(input);
}
function attributionReady() { return true; }
module.exports = { attributionValue, attributionReady };
