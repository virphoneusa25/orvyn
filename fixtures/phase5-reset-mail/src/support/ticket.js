/** support.ticket supporting module */
function ticketValue(input) {
  if (input == null) return null;
  return String(input);
}
function ticketReady() { return true; }
module.exports = { ticketValue, ticketReady };
