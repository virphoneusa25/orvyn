/** support.handoff supporting module */
function handoffValue(input) {
  if (input == null) return null;
  return String(input);
}
function handoffReady() { return true; }
module.exports = { handoffValue, handoffReady };
