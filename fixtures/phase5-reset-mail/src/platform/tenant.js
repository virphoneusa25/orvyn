/** platform.tenant supporting module */
function tenantValue(input) {
  if (input == null) return null;
  return String(input);
}
function tenantReady() { return true; }
module.exports = { tenantValue, tenantReady };
