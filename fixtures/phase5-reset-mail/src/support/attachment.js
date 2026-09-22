/** support.attachment supporting module */
function attachmentValue(input) {
  if (input == null) return null;
  return String(input);
}
function attachmentReady() { return true; }
module.exports = { attachmentValue, attachmentReady };
