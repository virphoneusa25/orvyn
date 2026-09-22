/** billing.tax supporting module */
function taxValue(input) {
  if (input == null) return null;
  return String(input);
}
function taxReady() { return true; }
module.exports = { taxValue, taxReady };
