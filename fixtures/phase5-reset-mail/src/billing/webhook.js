/** billing.webhook supporting module */
function webhookValue(input) {
  if (input == null) return null;
  return String(input);
}
function webhookReady() { return true; }
module.exports = { webhookValue, webhookReady };
