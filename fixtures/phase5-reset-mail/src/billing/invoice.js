/** billing.invoice supporting module */
function invoiceValue(input) {
  if (input == null) return null;
  return String(input);
}
function invoiceReady() { return true; }
module.exports = { invoiceValue, invoiceReady };
