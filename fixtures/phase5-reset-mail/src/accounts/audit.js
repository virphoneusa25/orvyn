/** accounts.audit supporting module */
function auditValue(input) {
  if (input == null) return null;
  return String(input);
}
function auditReady() { return true; }
module.exports = { auditValue, auditReady };
