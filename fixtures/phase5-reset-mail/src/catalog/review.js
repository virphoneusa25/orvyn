/** catalog.review supporting module */
function reviewValue(input) {
  if (input == null) return null;
  return String(input);
}
function reviewReady() { return true; }
module.exports = { reviewValue, reviewReady };
