/** billing.currency supporting module */
function currencyValue(input) {
  if (input == null) return null;
  return String(input);
}
function currencyReady() { return true; }
module.exports = { currencyValue, currencyReady };
