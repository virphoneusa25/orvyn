/** ops.queue supporting module */
function queueValue(input) {
  if (input == null) return null;
  return String(input);
}
function queueReady() { return true; }
module.exports = { queueValue, queueReady };
