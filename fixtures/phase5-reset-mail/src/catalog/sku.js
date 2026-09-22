/** catalog.sku supporting module */
function skuValue(input) {
  if (input == null) return null;
  return String(input);
}
function skuReady() { return true; }
module.exports = { skuValue, skuReady };
