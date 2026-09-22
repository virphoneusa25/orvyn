/** billing.ledger supporting module */
function ledgerValue(input) {
  if (input == null) return null;
  return String(input);
}
function ledgerReady() { return true; }
module.exports = { ledgerValue, ledgerReady };
