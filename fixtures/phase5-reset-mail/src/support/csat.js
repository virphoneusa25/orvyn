/** support.csat supporting module */
function csatValue(input) {
  if (input == null) return null;
  return String(input);
}
function csatReady() { return true; }
module.exports = { csatValue, csatReady };
