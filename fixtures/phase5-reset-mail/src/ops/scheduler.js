/** ops.scheduler supporting module */
function schedulerValue(input) {
  if (input == null) return null;
  return String(input);
}
function schedulerReady() { return true; }
module.exports = { schedulerValue, schedulerReady };
