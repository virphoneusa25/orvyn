/** platform.webhookOut supporting module */
function webhookOutValue(input) {
  if (input == null) return null;
  return String(input);
}
function webhookOutReady() { return true; }
module.exports = { webhookOutValue, webhookOutReady };
