/** billing.proration supporting module */
function prorationValue(input) {
  if (input == null) return null;
  return String(input);
}
function prorationReady() { return true; }
module.exports = { prorationValue, prorationReady };
