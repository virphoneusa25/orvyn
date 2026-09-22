/** analytics.retention supporting module */
function retentionValue(input) {
  if (input == null) return null;
  return String(input);
}
function retentionReady() { return true; }
module.exports = { retentionValue, retentionReady };
