/** analytics.event supporting module */
function eventValue(input) {
  if (input == null) return null;
  return String(input);
}
function eventReady() { return true; }
module.exports = { eventValue, eventReady };
