/** billing.creditNote supporting module */
function creditNoteValue(input) {
  if (input == null) return null;
  return String(input);
}
function creditNoteReady() { return true; }
module.exports = { creditNoteValue, creditNoteReady };
