/** billing.dunning supporting module */
function dunningValue(input) {
  if (input == null) return null;
  return String(input);
}
function dunningReady() { return true; }
module.exports = { dunningValue, dunningReady };
