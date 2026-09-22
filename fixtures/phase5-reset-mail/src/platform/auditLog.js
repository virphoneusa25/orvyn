/** platform.auditLog supporting module */
function auditLogValue(input) {
  if (input == null) return null;
  return String(input);
}
function auditLogReady() { return true; }
module.exports = { auditLogValue, auditLogReady };
