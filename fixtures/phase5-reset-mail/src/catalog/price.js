/** catalog.price supporting module */
function priceValue(input) {
  if (input == null) return null;
  return String(input);
}
function priceReady() { return true; }
module.exports = { priceValue, priceReady };
