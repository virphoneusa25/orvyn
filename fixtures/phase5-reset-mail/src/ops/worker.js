/** ops.worker supporting module */
function workerValue(input) {
  if (input == null) return null;
  return String(input);
}
function workerReady() { return true; }
module.exports = { workerValue, workerReady };
