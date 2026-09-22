/** catalog.product supporting module */
function productValue(input) {
  if (input == null) return null;
  return String(input);
}
function productReady() { return true; }
module.exports = { productValue, productReady };
