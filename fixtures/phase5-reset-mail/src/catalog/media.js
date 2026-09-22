/** catalog.media supporting module */
function mediaValue(input) {
  if (input == null) return null;
  return String(input);
}
function mediaReady() { return true; }
module.exports = { mediaValue, mediaReady };
